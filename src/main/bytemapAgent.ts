import { mkdir } from 'fs/promises'
import { dirname } from 'path'
import type {
  BytemapAgentEvent,
  BytemapAgentRequest,
  BytemapAgentResponse,
  OmpProviderSummary,
  PrivilegedHelperState
} from '@shared/types'
import { mapOmpToolExecutionEvent } from '../shared/agentToolDisplay'
import { ensureBytemapAgentSkills } from './bytemapAgentSkills'
import {
  BYTEMAP_AGENT_SYSTEM_PROMPT,
  buildBytemapAgentPrompt,
  buildBytemapAgentStateBlock,
  bytemapAgentPaths
} from './bytemapAgentPrompt'
import { createAgentSession } from '@oh-my-pi/pi-coding-agent/sdk'
import { Settings } from '@oh-my-pi/pi-coding-agent/config/settings'
import { SessionManager } from '@oh-my-pi/pi-coding-agent/session/session-manager'
import type { AgentSession } from '@oh-my-pi/pi-coding-agent/session/agent-session'

type AgentSessionEntry = {
  session: AgentSession
  cwd: string
  agentDir: string
  selectedModelId: string
  startedAt: number
  lastActivityAt: number
  promptCount: number
  activeRequestId: string | null
}

type ProviderRuntime = {
  providers: () => Promise<{ providers: OmpProviderSummary[]; selectedModelId: string | null }>
  getSelectedModel: () => unknown | null
  getSelectedModelId: () => string | null
  getAuthStorage: () => unknown
  getModelRegistry: () => unknown
}

type RuntimeDeps = {
  providers: ProviderRuntime
  helperCtlPath: () => string | null
  helperStatus: () => Promise<PrivilegedHelperState>
  refreshFullDiskAccess: () => Promise<boolean>
  sendEvent: (event: BytemapAgentEvent) => void
}

export class BytemapAgentRuntime {
  private readonly sessions = new Map<string, AgentSessionEntry>()

  constructor(private readonly deps: RuntimeDeps) {}

  async ask(request: BytemapAgentRequest): Promise<BytemapAgentResponse> {
    await this.deps.providers.providers()
    const selectedModel = this.deps.providers.getSelectedModel()
    const selectedModelId = this.deps.providers.getSelectedModelId()
    if (!selectedModel || !selectedModelId) {
      throw new Error(
        'No OMP model is connected. Connect Claude, Codex, OpenAI, Gemini, Copilot, Cursor, or a local model first.'
      )
    }

    const sessionId = request.sessionId || crypto.randomUUID()
    const entry = await this.getOrCreateSession(sessionId, selectedModelId, selectedModel)
    entry.activeRequestId = request.requestId
    entry.lastActivityAt = Date.now()
    const providerState = await this.deps.providers.providers()
    const stateBlock = buildBytemapAgentStateBlock({
      request,
      providerState,
      helperCtlPath: this.deps.helperCtlPath(),
      helperState: await this.deps.helperStatus(),
      fullDiskAccess: await this.deps.refreshFullDiskAccess()
    })
    const prompt = buildBytemapAgentPrompt(request, stateBlock)

    this.emit({ requestId: request.requestId, sessionId, type: 'status', text: 'Agent running…' })

    let streamedText = ''
    let finalText = ''
    const captureAssistant = (message: unknown): void => {
      const text = extractText(message)
      if (text) finalText = text
    }
    const unsubscribe = entry.session.subscribe((rawEvent: unknown) => {
      const event = asRecord(rawEvent)
      if (!event) return
      const eventType = typeof event.type === 'string' ? event.type : ''
      if (!eventType) return
      entry.lastActivityAt = Date.now()
      if (eventType === 'message_update') {
        const assistantEvent = asRecord(event.assistantMessageEvent)
        if (typeof assistantEvent?.delta === 'string') {
          if (assistantEvent.type === 'text_delta') {
            streamedText += assistantEvent.delta
            this.emit({
              requestId: request.requestId,
              sessionId,
              type: 'assistant_delta',
              text: assistantEvent.delta
            })
          } else if (assistantEvent.type === 'thinking_delta') {
            this.emit({
              requestId: request.requestId,
              sessionId,
              type: 'thinking_delta',
              text: assistantEvent.delta
            })
          }
        }
        captureAssistant(event.message)
      } else if (eventType === 'message_end') {
        const message = asRecord(event.message)
        if (message?.role === 'assistant') captureAssistant(message)
      } else if (eventType === 'agent_end') {
        const messages = Array.isArray(event.messages) ? event.messages : []
        captureAssistant(
          [...messages].reverse().find((message) => asRecord(message)?.role === 'assistant')
        )
      } else if (
        eventType === 'tool_execution_start' ||
        eventType === 'tool_execution_update' ||
        eventType === 'tool_execution_end'
      ) {
        const mapped = mapOmpToolExecutionEvent(eventType, event)
        if (!mapped) return
        const type =
          eventType === 'tool_execution_start'
            ? 'tool_start'
            : eventType === 'tool_execution_update'
              ? 'tool_update'
              : 'tool_end'
        this.emit({
          requestId: request.requestId,
          sessionId,
          type,
          toolName: mapped.toolName,
          toolCallId: mapped.toolCallId,
          argsText: mapped.argsText,
          text: mapped.text,
          ok: mapped.ok
        })
      } else if (eventType === 'notice' && typeof event.message === 'string') {
        this.emit({ requestId: request.requestId, sessionId, type: 'status', text: event.message })
      }
    })

    try {
      await entry.session.prompt(prompt, { expandPromptTemplates: false })
      entry.promptCount += 1
      entry.activeRequestId = null
      const answer = finalText || streamedText
      return { requestId: request.requestId, sessionId, answer }
    } catch (error) {
      const text = errorMessage(error)
      this.emit({ requestId: request.requestId, sessionId, type: 'error', text })
      throw error
    } finally {
      unsubscribe()
      entry.activeRequestId = null
    }
  }

  async reset(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    this.sessions.delete(sessionId)
    await entry.session.dispose()
  }

  async cancel(requestId: string, sessionId: string): Promise<{ ok: boolean; reason?: string }> {
    let entry = this.sessions.get(sessionId)
    if (!entry || entry.activeRequestId !== requestId) {
      entry = [...this.sessions.values()].find((candidate) => candidate.activeRequestId === requestId)
    }
    if (!entry || entry.activeRequestId !== requestId)
      return { ok: false, reason: 'request not active' }
    if (typeof entry.session.abort !== 'function') return { ok: false, reason: 'abort unavailable' }
    try {
      await entry.session.abort({
        reason: 'Bytemap user stopped the agent',
        goalReason: 'interrupted'
      })
    } catch {
      // Already idle / torn down — treat as successful stop.
    }
    entry.activeRequestId = null
    return { ok: true }
  }

  async disposeAll(): Promise<void> {
    const entries = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.allSettled(entries.map((entry) => entry.session.dispose()))
  }

  private async getOrCreateSession(
    sessionId: string,
    selectedModelId: string,
    selectedModel: unknown
  ): Promise<AgentSessionEntry> {
    const existing = this.sessions.get(sessionId)
    if (existing && existing.selectedModelId === selectedModelId) return existing
    if (existing) await this.reset(sessionId)

    const paths = bytemapAgentPaths()
    await mkdir(paths.agentDir, { recursive: true, mode: 0o700 })
    await ensureBytemapAgentSkills(paths.agentDir)
    applyEmbeddedOmpEnvironment(paths.ompHome, paths.agentDir, this.deps.helperCtlPath())
    const settings = await Settings.loadIsolated({ cwd: paths.cwd, agentDir: paths.agentDir })
    const result = await createAgentSession({
      cwd: paths.cwd,
      agentDir: paths.agentDir,
      sessionManager: SessionManager.inMemory(paths.cwd),
      settings,
      hasUI: false,
      authStorage: this.deps.providers.getAuthStorage() as never,
      modelRegistry: this.deps.providers.getModelRegistry() as never,
      model: selectedModel as never,
      systemPrompt: BYTEMAP_AGENT_SYSTEM_PROMPT,
      autoApprove: true
    })
    const entry: AgentSessionEntry = {
      session: result.session,
      cwd: paths.cwd,
      agentDir: paths.agentDir,
      selectedModelId,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      promptCount: 0,
      activeRequestId: null
    }
    this.sessions.set(sessionId, entry)
    return entry
  }

  private emit(event: BytemapAgentEvent): void {
    this.deps.sendEvent(event)
  }
}

export function providerStateForPrompt(
  providers: OmpProviderSummary[],
  selectedModelId: string | null
): { providers: OmpProviderSummary[]; selectedModelId: string | null } {
  return { providers, selectedModelId }
}

function applyEmbeddedOmpEnvironment(
  ompHome: string,
  agentDir: string,
  helperCtlPath: string | null
): void {
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.OMP_AGENT_DIR = agentDir
  process.env.HOME = ompHome
  if (helperCtlPath) {
    const helperDir = dirname(helperCtlPath)
    const pathParts = (process.env.PATH || '').split(':')
    if (!pathParts.includes(helperDir)) process.env.PATH = `${helperDir}:${process.env.PATH || ''}`
  }
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join('\n')
  const record = asRecord(value)
  if (!record) return ''
  if (typeof record.text === 'string') return record.text
  if (typeof record.content === 'string') return record.content
  if (Array.isArray(record.content))
    return record.content.map(extractText).filter(Boolean).join('\n')
  if (Array.isArray(record.parts)) return record.parts.map(extractText).filter(Boolean).join('\n')
  return ''
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
