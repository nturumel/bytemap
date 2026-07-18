import { mkdir } from 'fs/promises'
import { dirname } from 'path'
import type {
  BytemapAgentEvent,
  BytemapAgentRequest,
  BytemapAgentResponse,
  OmpProviderSummary,
  PrivilegedHelperState
} from '@shared/types'
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
    const prompt = buildBytemapAgentPrompt(request, stateBlock, entry.promptCount === 0)

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
      } else if (eventType === 'tool_execution_start') {
        this.emit({
          requestId: request.requestId,
          sessionId,
          type: 'tool_start',
          toolName: typeof event.toolName === 'string' ? event.toolName : 'tool',
          text:
            typeof event.intent === 'string' ? sanitizeToolOutputExcerpt(event.intent) : undefined
        })
      } else if (eventType === 'tool_execution_update') {
        const excerpt = toolEventOutputExcerpt(event)
        this.emit({
          requestId: request.requestId,
          sessionId,
          type: 'tool_update',
          toolName: typeof event.toolName === 'string' ? event.toolName : 'tool',
          text: excerpt ?? undefined
        })
      } else if (eventType === 'tool_execution_end') {
        const excerpt = toolEventOutputExcerpt(event)
        this.emit({
          requestId: request.requestId,
          sessionId,
          type: 'tool_end',
          toolName: typeof event.toolName === 'string' ? event.toolName : 'tool',
          text: excerpt ?? undefined,
          ok: event.ok !== false
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
    const entry = this.sessions.get(sessionId)
    if (!entry || entry.activeRequestId !== requestId)
      return { ok: false, reason: 'request not active' }
    if (typeof entry.session.abort !== 'function') return { ok: false, reason: 'abort unavailable' }
    await entry.session.abort({
      reason: 'Bytemap user stopped the agent',
      goalReason: 'interrupted'
    })
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

function toolEventOutputExcerpt(event: Record<string, unknown>): string | null {
  const text = extractText(event.partialResult ?? event.result ?? event.details)
  if (!text.trim()) return null
  return cappedRedactedExcerpt(sanitizeToolOutputExcerpt(text), 600)
}

function sanitizeToolOutputExcerpt(value: string): string {
  const sanitized = value
    .split(/\r?\n/)
    .filter(
      (line) =>
        !line.startsWith(
          '** WARNING: connection is not using a post-quantum key exchange algorithm.'
        )
    )
    .filter((line) => !line.startsWith('** This session may be vulnerable'))
    .filter((line) => !line.startsWith('** The server may need to be upgraded.'))
    .filter((line) => !line.startsWith('Warning: Permanently added '))
    .filter((line) => line !== '\\S')
    .filter((line) => line !== 'Kernel \\r on an \\m')
    .join('\n')
  return sanitized.trim() ? sanitized : value
}

function cappedRedactedExcerpt(value: string, maxLength: number): string {
  const redacted = value
    .replace(/(OPENAI_API_KEY=)[^\s"']+/giu, '$1[REDACTED]')
    .replace(/(OPENAI_CODEX_OAUTH_TOKEN=)[^\s"']+/giu, '$1[REDACTED]')
    .replace(/(ANTHROPIC_API_KEY=)[^\s"']+/giu, '$1[REDACTED]')
    .replace(/(ANTHROPIC_OAUTH_TOKEN=)[^\s"']+/giu, '$1[REDACTED]')
    .replace(/(GEMINI_API_KEY=)[^\s"']+/giu, '$1[REDACTED]')
    .replace(/(CURSOR_ACCESS_TOKEN=)[^\s"']+/giu, '$1[REDACTED]')
    .replace(/(COPILOT_GITHUB_TOKEN=)[^\s"']+/giu, '$1[REDACTED]')
    .replace(/(Authorization:\s*Bearer\s+)[^\s"']+/giu, '$1[REDACTED]')
    .replace(
      /((?:password|passwd|token|secret|private[_-]?key|ssh[_-]?identity)\s*[:=]\s*)[^\s"']+/giu,
      '$1[REDACTED]'
    )
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}…` : redacted
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
