import { type ComponentProps, useEffect, useMemo, useRef, useState } from 'react'
import { Streamdown } from 'streamdown'
import 'streamdown/styles.css'
import type { BytemapAgentContext, OmpProviderSummary } from '@shared/types'
import {
  type AgentChatMessage,
  type AgentToolTranscript,
  useBytemapAgentChat
} from '../hooks/useBytemapAgentChat'

type AgentChatWidgetProps = {
  context: BytemapAgentContext
  seedPrompt?: string | null
  buttonLabel?: string
}

export function AgentChatWidget({
  context,
  seedPrompt,
  buttonLabel = 'Agent'
}: AgentChatWidgetProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const chat = useBytemapAgentChat(context)
  const selectedModel = chat.providers?.selectedModelId ?? null
  const hasModels = Boolean(chat.providers?.providers.some((provider) => provider.models.length > 0))
  const showProviderPanel = !selectedModel

  const seededInput = useMemo(() => seedPrompt ?? '', [seedPrompt])
  const messageEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ block: 'nearest' })
  }, [chat.messages])

  return (
    <div className="no-drag fixed right-3 bottom-3 z-50 flex max-w-[calc(100vw-1.5rem)] flex-col items-end gap-3">
      {open && (
        <div className="flex h-[min(760px,calc(100vh-5.5rem))] w-[min(640px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl border border-[var(--viz-rule)] bg-[var(--viz-panel)] shadow-2xl">
          <header className="flex items-center justify-between gap-3 border-b border-[var(--viz-rule)] px-5 py-3.5">
            <div>
              <h2 className="font-display text-sm font-semibold">Bytemap agent</h2>
              <p className="font-mono text-[10px] text-[var(--viz-muted)]">
                {selectedModel ? selectedModel : 'Connect an agent model'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {chat.loading ? (
                <button type="button" className="agent-chip" onClick={() => void chat.stop()}>
                  Stop
                </button>
              ) : (
                <button type="button" className="agent-chip" onClick={() => void chat.reset()}>
                  Reset
                </button>
              )}
              <button type="button" className="agent-chip" onClick={() => setOpen(false)}>
                Close
              </button>
            </div>
          </header>

          {showProviderPanel ? (
            <AgentProviderPanel chat={chat} hasModels={hasModels} />
          ) : (
            <>
              <div
                className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4"
                aria-live="polite"
              >
                {chat.messages.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-[var(--viz-rule)] p-4 text-sm leading-relaxed text-[var(--viz-muted)]">
                    <p>
                      Agent has terminal, cache, and app-context access. Ask it to inspect, clean generated bulk,
                      find, move, trash, or remove local targets.
                    </p>
                  </div>
                ) : (
                  chat.messages.map((message) => <AgentMessageBubble key={message.id} message={message} />)
                )}
                <div ref={messageEndRef} aria-hidden="true" />
              </div>

              <form
                className="border-t border-[var(--viz-rule)] p-4"
                onSubmit={(event) => {
                  event.preventDefault()
                  void chat.askAgent(chat.input || seededInput)
                }}
              >
                <textarea
                  value={chat.input}
                  onChange={(event) => chat.setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key !== 'Enter' ||
                      event.shiftKey ||
                      event.nativeEvent.isComposing
                    )
                      return
                    event.preventDefault()
                    event.currentTarget.form?.requestSubmit()
                  }}
                  onFocus={() => {
                    if (!chat.input && seededInput) chat.setInput(seededInput)
                  }}
                  placeholder="Ask anything, or tell the agent what to clean, find, move, trash, or remove…"
                  className="h-20 w-full resize-none rounded-xl border border-[var(--viz-rule)] bg-transparent p-3 text-sm leading-relaxed outline-none focus:border-[var(--viz-dir)]"
                  disabled={chat.loading}
                />
                <div className="mt-2 flex items-center justify-between gap-3">
                  <div className="min-w-0 text-[10px] text-[var(--viz-muted)]">
                    <p>Terminal + cache access · cleans before cloud moves · reports changes</p>
                    <p className="mt-0.5 font-mono">Enter send · Shift+Enter newline</p>
                  </div>
                  <button
                    type="submit"
                    disabled={chat.loading || !(chat.input || seededInput).trim()}
                    className="rounded-lg bg-[var(--viz-dir)] px-4 py-2 text-xs font-semibold text-white transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    Send
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="rounded-full bg-[var(--viz-dir)] px-5 py-3 text-sm font-semibold text-white shadow-xl transition active:scale-[0.98]"
      >
        {buttonLabel}
      </button>
    </div>
  )
}

type AgentProviderPanelProps = {
  chat: ReturnType<typeof useBytemapAgentChat>
  hasModels: boolean
}

function AgentProviderPanel({ chat, hasModels }: AgentProviderPanelProps): React.JSX.Element {
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({})
  const providers = chat.providers?.providers ?? []
  const busy = chat.providerLoading

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mb-4 rounded-lg border border-[var(--viz-rule)] p-3">
        <h3 className="font-display text-sm font-semibold">Connect an agent model</h3>
        <p className="mt-1 text-xs text-[var(--viz-muted)]">
          Chat stays disabled until one OMP model is available and selected.
        </p>
        {busy && <p className="mt-2 text-xs text-[var(--viz-muted)]">Checking agent backend…</p>}
        {chat.providerError && (
          <div className="mt-2 flex items-start justify-between gap-3 rounded border border-red-500/25 bg-red-500/5 p-2">
            <p className="min-w-0 text-xs text-red-500">{chat.providerError}</p>
            <button type="button" className="agent-chip shrink-0" onClick={() => void chat.refreshProviders()} disabled={busy}>
              Retry
            </button>
          </div>
        )}
      </div>

      <div className="grid gap-3">
        {providers.map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            apiKey={apiKeys[provider.id] ?? ''}
            setApiKey={(value) => setApiKeys((current) => ({ ...current, [provider.id]: value }))}
            busy={busy}
            onRefresh={() => void chat.refreshProviders()}
            onLogin={() => void chat.loginProvider(provider.id)}
            onSetApiKey={() => void chat.setProviderApiKey(provider.id, apiKeys[provider.id] ?? '')}
            onLogout={() => void chat.logoutProvider(provider.id)}
            onSelectModel={(modelId) => void chat.selectModel(modelId)}
          />
        ))}
      </div>

      {providers.length === 0 && (
        <p className="mt-4 text-xs text-[var(--viz-muted)]">
          {busy ? 'Loading provider and model availability…' : 'No providers reported by the agent backend.'}
        </p>
      )}

      {!hasModels && (
        <p className="mt-4 text-xs text-[var(--viz-muted)]">
          Local model cards show unavailable until Ollama, LM Studio, or llama.cpp is running.
        </p>
      )}
    </div>
  )
}

function ProviderCard({
  provider,
  apiKey,
  setApiKey,
  busy,
  onRefresh,
  onLogin,
  onSetApiKey,
  onLogout,
  onSelectModel
}: {
  provider: OmpProviderSummary
  apiKey: string
  setApiKey: (value: string) => void
  busy: boolean
  onRefresh: () => void
  onLogin: () => void
  onSetApiKey: () => void
  onLogout: () => void
  onSelectModel: (modelId: string) => void
}): React.JSX.Element {
  return (
    <section className="rounded-lg border border-[var(--viz-rule)] bg-black/[0.02] p-3 dark:bg-white/[0.03]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold">{provider.label}</h4>
          <p className="font-mono text-[10px] text-[var(--viz-muted)]">
            {provider.id} · {provider.status}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {provider.authKind === 'oauth' && (
            <button type="button" className="agent-chip" onClick={onLogin} disabled={busy}>
              {busy ? 'Working…' : 'Connect'}
            </button>
          )}
          {provider.authKind === 'local' && (
            <button type="button" className="agent-chip" onClick={onRefresh} disabled={busy}>
              {busy ? 'Refreshing…' : 'Refresh local models'}
            </button>
          )}
          {provider.logoutSupported && provider.status === 'available' && (
            <button type="button" className="agent-chip" onClick={onLogout} disabled={busy}>
              {busy ? 'Working…' : 'Disconnect'}
            </button>
          )}
        </div>
      </div>

      {provider.authKind === 'apiKey' && (
        <div className="mt-3 flex gap-2">
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="Paste API key"
            className="min-w-0 flex-1 rounded border border-[var(--viz-rule)] bg-transparent px-2 py-1.5 text-xs outline-none focus:border-[var(--viz-dir)]"
            disabled={busy}
          />
          <button type="button" className="agent-chip" onClick={onSetApiKey} disabled={busy || !apiKey.trim()}>
            {busy ? 'Saving…' : 'Add API key'}
          </button>
        </div>
      )}

      {provider.models.length > 0 && (
        <div className="mt-3 space-y-1">
          {provider.models.map((model) => (
            <label
              key={model.id}
              className={`flex items-center gap-2 text-xs ${busy ? 'cursor-wait opacity-60' : 'cursor-pointer'}`}
            >
              <input
                type="radio"
                checked={model.selected}
                onChange={() => onSelectModel(model.id)}
                name="agent-model"
                disabled={busy}
              />
              <span>{model.label}</span>
              <span className="font-mono text-[10px] text-[var(--viz-muted)]">{model.id}</span>
            </label>
          ))}
        </div>
      )}
    </section>
  )
}

function AgentMessageBubble({ message }: { message: AgentChatMessage }): React.JSX.Element {
  const isUser = message.role === 'user'

  return (
    <article
      className={`rounded-xl border px-4 py-3 text-sm ${
        isUser
          ? 'ml-8 border-[var(--viz-dir)] bg-[var(--viz-dir)]/10'
          : 'mr-8 border-[var(--viz-rule)] bg-black/[0.02] dark:bg-white/[0.03]'
      }`}
    >
      {message.status && !message.text && !message.thinking && (
        <div className="flex items-center gap-2 font-mono text-[11px] text-[var(--viz-muted)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--viz-dir)]" aria-hidden="true" />
          <span>{message.status.replace(/…$/, '')}</span>
        </div>
      )}
      {message.thinking && (
        <AgentThinkingBlock
          text={message.thinking}
          active={Boolean(message.streaming && !message.text)}
        />
      )}
      {message.text &&
        (isUser ? (
          <div className="whitespace-pre-wrap leading-relaxed">{message.text}</div>
        ) : (
          <AgentMarkdown text={message.text} streaming={Boolean(message.streaming)} />
        ))}
      {!message.text && !message.status && !message.thinking && (
        <div className="text-[var(--viz-muted)]">…</div>
      )}
      {message.tools && message.tools.length > 0 && (
        <div className="mt-3 space-y-2">
          {message.tools.map((tool) => (
            <AgentToolCard key={tool.id} tool={tool} />
          ))}
        </div>
      )}
    </article>
  )
}

function AgentThinkingBlock({ text, active }: { text: string; active: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(active)


  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="mb-3 overflow-hidden rounded-lg border border-[var(--viz-rule)] bg-[var(--viz-field)]/55"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--viz-muted)]">
        <span>Thinking</span>
        <span>{active ? 'Live' : open ? 'Hide' : 'Show'}</span>
      </summary>
      <div className="max-h-56 overflow-auto border-t border-[var(--viz-rule)] px-3 py-2 text-[12px] text-[var(--viz-muted)]">
        <AgentMarkdown text={text} streaming={active} />
      </div>
    </details>
  )
}

function AgentMarkdown({ text, streaming }: { text: string; streaming: boolean }): React.JSX.Element {
  return (
    <Streamdown
      mode={streaming ? 'streaming' : 'static'}
      parseIncompleteMarkdown={streaming}
      isAnimating={streaming}
      animated={false}
      lineNumbers={false}
      skipHtml
      className="bytemap-markdown"
      components={{ a: AgentMarkdownLink }}
    >
      {text}
    </Streamdown>
  )
}

function AgentMarkdownLink(
  props: ComponentProps<'a'> & { node?: unknown }
): React.JSX.Element {
  const { node, ...anchorProps } = props
  void node
  return <a {...anchorProps} target="_blank" rel="noreferrer noopener" />
}

function AgentToolCard({ tool }: { tool: AgentToolTranscript }): React.JSX.Element {
  const [open, setOpen] = useState(tool.status === 'running')
  return (
    <details
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
      className="rounded border border-[var(--viz-rule)] p-2 font-mono text-[10px]"
    >
      <summary className="cursor-pointer list-none text-[var(--viz-muted)]">
        {tool.toolName} · {tool.status}
      </summary>
      {tool.text && <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap">{tool.text}</pre>}
    </details>
  )
}
