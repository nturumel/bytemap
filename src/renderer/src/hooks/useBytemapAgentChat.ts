import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BytemapAgentContext,
  BytemapAgentEvent,
  BytemapAgentResponse,
  OmpProviderSnapshot
} from '@shared/types'

export type AgentToolTranscript = {
  id: string
  toolCallId?: string
  toolName: string
  status: 'running' | 'complete' | 'failed'
  argsText?: string
  text?: string
}

export type AgentChatMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  status?: string
  thinking?: string
  streaming?: boolean
  tools?: AgentToolTranscript[]
}

export function useBytemapAgentChat(context: BytemapAgentContext): {
  messages: AgentChatMessage[]
  input: string
  setInput: (value: string) => void
  loading: boolean
  sessionId: string | null
  activeRequestId: string | null
  providers: OmpProviderSnapshot | null
  providerLoading: boolean
  providerError: string | null
  refreshProviders: () => Promise<void>
  loginProvider: (providerId: string) => Promise<void>
  setProviderApiKey: (providerId: string, apiKey: string) => Promise<void>
  logoutProvider: (providerId: string) => Promise<void>
  /** Sign out the active provider: clears credentials (when applicable), chat, and session. */
  signOut: () => Promise<void>
  selectModel: (modelId: string) => Promise<void>
  askAgent: (message?: string) => Promise<void>
  reset: () => Promise<void>
  stop: () => Promise<void>
} {
  const [messages, setMessages] = useState<AgentChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null)
  const [providers, setProviders] = useState<OmpProviderSnapshot | null>(null)
  const [providerLoading, setProviderLoading] = useState(false)
  const [providerError, setProviderError] = useState<string | null>(null)
  const activeAssistantId = useRef<string | null>(null)
  const activeRequestRef = useRef<string | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const stoppedRequestIdRef = useRef<string | null>(null)
  const providerOperationSeq = useRef(0)

  sessionIdRef.current = sessionId

  const selectedModelId = providers?.selectedModelId ?? null

  const runProviderOperation = useCallback(async (operation: () => Promise<OmpProviderSnapshot>) => {
    const sequence = providerOperationSeq.current + 1
    providerOperationSeq.current = sequence
    setProviderLoading(true)
    setProviderError(null)
    try {
      const snapshot = await operation()
      if (providerOperationSeq.current !== sequence) return false
      setProviders(snapshot)
      return true
    } catch (error) {
      if (providerOperationSeq.current === sequence) setProviderError(errorMessage(error))
      return false
    } finally {
      if (providerOperationSeq.current === sequence) setProviderLoading(false)
    }
  }, [])

  const refreshProviders = useCallback(async () => {
    await runProviderOperation(() => window.api.agent.providers())
  }, [runProviderOperation])

  useEffect(() => {
    void refreshProviders()
  }, [refreshProviders])

  useEffect(() => {
    return window.api.agent.onEvent((event) => {
      if (event.requestId !== activeRequestRef.current) return
      applyAgentEvent(event)
    })
  }, [])

  const applyAgentEvent = useCallback((event: BytemapAgentEvent) => {
    const assistantId = activeAssistantId.current
    if (!assistantId) return
    setMessages((current) =>
      current.map((message) => {
        if (message.id !== assistantId) return message
        if (event.type === 'assistant_delta') {
          return { ...message, text: message.text + event.text, status: undefined }
        }
        if (event.type === 'thinking_delta') {
          return { ...message, thinking: (message.thinking ?? '') + event.text }
        }
        if (event.type === 'status') {
          return { ...message, status: event.text }
        }
        if (event.type === 'error') {
          return { ...message, text: message.text || event.text, status: undefined }
        }
        const tools = [...(message.tools ?? [])]
        const existingIndex = findRunningToolIndex(tools, event)
        if (event.type === 'tool_start') {
          tools.push({
            id: event.toolCallId ?? `${event.toolName}-${Date.now()}-${tools.length}`,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            status: 'running',
            argsText: event.argsText,
            text: event.text
          })
        } else if (event.type === 'tool_update') {
          if (existingIndex >= 0) {
            const existing = tools[existingIndex]!
            tools[existingIndex] = {
              ...existing,
              argsText: event.argsText ?? existing.argsText,
              // OMP partialResult is a full snapshot — replace, do not append.
              text: event.text !== undefined ? event.text : existing.text
            }
          } else {
            tools.push({
              id: event.toolCallId ?? `${event.toolName}-${Date.now()}-${tools.length}`,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              status: 'running',
              argsText: event.argsText,
              text: event.text
            })
          }
        } else if (event.type === 'tool_end') {
          if (existingIndex >= 0) {
            const existing = tools[existingIndex]!
            tools[existingIndex] = {
              ...existing,
              status: event.ok === false ? 'failed' : 'complete',
              argsText: event.argsText ?? existing.argsText,
              text: event.text !== undefined ? event.text : existing.text
            }
          } else {
            tools.push({
              id: event.toolCallId ?? `${event.toolName}-${Date.now()}-${tools.length}`,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              status: event.ok === false ? 'failed' : 'complete',
              argsText: event.argsText,
              text: event.text
            })
          }
        }
        return { ...message, tools }
      })
    )
  }, [])

  const askAgent = useCallback(
    async (override?: string) => {
      const text = (override ?? input).trim()
      if (!text || loading || !selectedModelId) return
      const requestId = crypto.randomUUID()
      const assistantId = crypto.randomUUID()
      // Allocate session id before ask resolves so Stop can cancel mid-turn (incl. first message).
      const nextSessionId = sessionIdRef.current ?? crypto.randomUUID()
      sessionIdRef.current = nextSessionId
      setSessionId(nextSessionId)
      activeAssistantId.current = assistantId
      activeRequestRef.current = requestId
      setActiveRequestId(requestId)
      setLoading(true)
      setInput('')
      setMessages((current) => [
        ...current,
        { id: crypto.randomUUID(), role: 'user', text },
        { id: assistantId, role: 'assistant', text: '', streaming: true, tools: [] }
      ])
      try {
        const response: BytemapAgentResponse = await window.api.agent.ask({
          sessionId: nextSessionId,
          requestId,
          message: text,
          context
        })
        if (stoppedRequestIdRef.current === requestId) return
        sessionIdRef.current = response.sessionId
        setSessionId(response.sessionId)
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantId
              ? { ...message, text: message.text || response.answer, status: undefined, streaming: false }
              : message
          )
        )
      } catch (error) {
        if (stoppedRequestIdRef.current === requestId) return
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantId
              ? { ...message, text: errorMessage(error), status: undefined, streaming: false }
              : message
          )
        )
      } finally {
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantId ? { ...message, status: undefined, streaming: false } : message
          )
        )
        if (activeRequestRef.current === requestId) {
          setLoading(false)
          setActiveRequestId(null)
          activeRequestRef.current = null
          activeAssistantId.current = null
        }
        if (stoppedRequestIdRef.current === requestId) stoppedRequestIdRef.current = null
      }
    },
    [context, input, loading, selectedModelId]
  )

  const reset = useCallback(async () => {
    const sid = sessionIdRef.current
    if (sid) await window.api.agent.reset(sid)
    sessionIdRef.current = null
    setSessionId(null)
    setMessages([])
  }, [])

  const stop = useCallback(async () => {
    const requestId = activeRequestRef.current
    const sid = sessionIdRef.current
    if (!requestId) return

    stoppedRequestIdRef.current = requestId
    const assistantId = activeAssistantId.current
    setLoading(false)
    setActiveRequestId(null)
    activeRequestRef.current = null
    if (assistantId) {
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                status: undefined,
                streaming: false,
                text: message.text.trim() ? message.text : 'Stopped.',
                tools: (message.tools ?? []).map((tool) =>
                  tool.status === 'running' ? { ...tool, status: 'failed' } : tool
                )
              }
            : message
        )
      )
      activeAssistantId.current = null
    }

    if (!sid) return
    try {
      const result = await window.api.agent.cancel(requestId, sid)
      // Race after natural completion: treat as soft success.
      if (!result.ok && result.reason === 'abort unavailable') await window.api.agent.reset(sid)
    } catch {
      // Ignore cancel races once the turn already finished.
    }
  }, [])

  const loginProvider = useCallback(
    async (providerId: string) => {
      await runProviderOperation(() => window.api.agent.loginProvider(providerId))
    },
    [runProviderOperation]
  )

  const setProviderApiKey = useCallback(
    async (providerId: string, apiKey: string) => {
      await runProviderOperation(() => window.api.agent.setProviderApiKey(providerId, apiKey))
    },
    [runProviderOperation]
  )

  const logoutProvider = useCallback(
    async (providerId: string) => {
      const sid = sessionIdRef.current
      if (sid) {
        await window.api.agent.reset(sid)
        sessionIdRef.current = null
        setSessionId(null)
      }
      const ok = await runProviderOperation(() => window.api.agent.logoutProvider(providerId))
      if (ok) {
        setMessages([])
        setLoading(false)
        setActiveRequestId(null)
        activeRequestRef.current = null
        activeAssistantId.current = null
        stoppedRequestIdRef.current = null
      }
    },
    [runProviderOperation]
  )

  const signOut = useCallback(async () => {
    const modelId = providers?.selectedModelId
    if (!modelId) return
    const slash = modelId.indexOf('/')
    const providerId = slash === -1 ? modelId : modelId.slice(0, slash)
    await logoutProvider(providerId)
  }, [logoutProvider, providers?.selectedModelId])

  const selectModel = useCallback(async (modelId: string) => {
    const sequence = providerOperationSeq.current + 1
    providerOperationSeq.current = sequence
    setProviderLoading(true)
    setProviderError(null)
    try {
      await window.api.agent.selectModel(modelId)
      const snapshot = await window.api.agent.providers()
      if (providerOperationSeq.current !== sequence) return
      setProviders(snapshot)
      sessionIdRef.current = null
      setSessionId(null)
      setMessages([])
    } catch (error) {
      if (providerOperationSeq.current === sequence) setProviderError(errorMessage(error))
    } finally {
      if (providerOperationSeq.current === sequence) setProviderLoading(false)
    }
  }, [])

  return useMemo(
    () => ({
      messages,
      input,
      setInput,
      loading,
      sessionId,
      activeRequestId,
      providers,
      providerLoading,
      providerError,
      refreshProviders,
      loginProvider,
      setProviderApiKey,
      logoutProvider,
      signOut,
      selectModel,
      askAgent,
      reset,
      stop
    }),
    [
      messages,
      input,
      loading,
      sessionId,
      activeRequestId,
      providers,
      providerLoading,
      providerError,
      refreshProviders,
      loginProvider,
      setProviderApiKey,
      logoutProvider,
      signOut,
      selectModel,
      askAgent,
      reset,
      stop
    ]
  )
}

function findRunningToolIndex(
  tools: AgentToolTranscript[],
  event: Extract<BytemapAgentEvent, { type: 'tool_start' | 'tool_update' | 'tool_end' }>
): number {
  if (event.toolCallId) {
    const byId = tools.findIndex(
      (tool) => tool.toolCallId === event.toolCallId || tool.id === event.toolCallId
    )
    if (byId >= 0) return byId
  }
  return tools.findIndex((tool) => tool.toolName === event.toolName && tool.status === 'running')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
