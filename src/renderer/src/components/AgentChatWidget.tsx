import { type ComponentProps, useEffect, useMemo, useRef, useState } from 'react'
import { Streamdown } from 'streamdown'
import 'streamdown/styles.css'
import type { BytemapAgentContext, OmpProviderSummary } from '@shared/types'
import { formatBytes } from '@shared/format'
import {
  type AgentChatMessage,
  type AgentToolTranscript,
  useBytemapAgentChat
} from '../hooks/useBytemapAgentChat'
import {
  type CleanupPlan,
  type CleanupPlanAction,
  type CleanupPlanItem,
  type CleanupPlanTierId,
  parseAgentAnswer
} from '../lib/agentCleanupPlan'

type AgentChatWidgetProps = {
  context: BytemapAgentContext
  seedPrompt?: string | null
  buttonLabel?: string
}

type PanelMode = 'closed' | 'open' | 'minimized'

export function AgentChatWidget({
  context,
  seedPrompt,
  buttonLabel = 'Agent'
}: AgentChatWidgetProps): React.JSX.Element {
  const [panelMode, setPanelMode] = useState<PanelMode>('closed')
  const chat = useBytemapAgentChat(context)
  const selectedModel = chat.providers?.selectedModelId ?? null
  const hasModels = Boolean(
    chat.providers?.providers.some((provider) => provider.models.length > 0)
  )
  const showProviderPanel = !selectedModel

  const seededInput = useMemo(() => seedPrompt ?? '', [seedPrompt])
  const messageEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ block: 'nearest' })
  }, [chat.messages])

  return (
    <div className="no-drag fixed right-3 bottom-3 z-50 flex max-w-[calc(100vw-1.5rem)] flex-col items-end gap-3">
      {panelMode === 'open' && (
        <div className="flex h-[min(760px,calc(100vh-5.5rem))] w-[min(640px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl border border-[var(--viz-rule)] bg-[var(--viz-panel)] shadow-2xl">
          <header className="flex items-center justify-between gap-3 border-b border-[var(--viz-rule)] px-4 py-2.5">
            <div className="min-w-0">
              <h2 className="font-display text-sm font-semibold">Bytemap agent</h2>
              <p className="truncate font-mono text-[10px] text-[var(--viz-muted)]">
                {selectedModel ? selectedModel : 'Connect an agent model'}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                className="agent-icon-btn"
                onClick={() => void chat.reset()}
                disabled={chat.loading}
                aria-label="Reset conversation"
                title="Reset conversation"
              >
                <AgentResetIcon />
              </button>
              {selectedModel && (
                <button
                  type="button"
                  className="agent-icon-btn agent-icon-btn--danger"
                  onClick={() => {
                    const confirmed = window.confirm(
                      'Sign out of the agent? This clears provider credentials for the active model, ends the chat session, and returns you to the login screen.'
                    )
                    if (confirmed) void chat.signOut()
                  }}
                  disabled={chat.loading || chat.providerLoading}
                  aria-label="Sign out"
                  title="Sign out"
                >
                  <AgentLogoutIcon />
                </button>
              )}
              <button
                type="button"
                className="agent-icon-btn"
                onClick={() => setPanelMode('minimized')}
                aria-label="Minimize"
                title="Minimize"
              >
                <AgentMinimizeIcon />
              </button>
              <button
                type="button"
                className="agent-icon-btn agent-icon-btn--danger"
                onClick={() => setPanelMode('closed')}
                aria-label="Close"
                title="Close"
              >
                <AgentCloseIcon />
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
                      Agent has terminal, cache, and app-context access. Ask it to inspect, clean
                      generated bulk, find, move, trash, or remove local targets.
                    </p>
                  </div>
                ) : (
                  chat.messages.map((message) => (
                    <AgentMessageBubble key={message.id} message={message} />
                  ))
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
                    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing)
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
                  {chat.loading ? (
                    <button
                      type="button"
                      className="agent-stop-btn"
                      onClick={() => void chat.stop()}
                      aria-label="Stop agent"
                      title="Stop agent"
                    >
                      <AgentStopIcon />
                    </button>
                  ) : (
                    <button
                      type="submit"
                      disabled={!(chat.input || seededInput).trim()}
                      className="agent-send-btn"
                      aria-label="Send message"
                      title="Send message"
                    >
                      <AgentSendIcon />
                    </button>
                  )}
                </div>
              </form>
            </>
          )}
        </div>
      )}

      {panelMode === 'minimized' ? (
        <button
          type="button"
          onClick={() => setPanelMode('open')}
          className="agent-minimized-chip"
          aria-label="Restore Bytemap agent"
        >
          {chat.loading && <span className="agent-minimized-chip__pulse" aria-hidden="true" />}
          <span>Bytemap agent</span>
          {chat.loading && <span className="agent-minimized-chip__status">Running</span>}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setPanelMode((mode) => (mode === 'open' ? 'closed' : 'open'))}
          className="rounded-full bg-[var(--viz-dir)] px-5 py-3 text-sm font-semibold text-white shadow-xl transition active:scale-[0.98]"
        >
          {buttonLabel}
        </button>
      )}
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
            <button
              type="button"
              className="agent-chip shrink-0"
              onClick={() => void chat.refreshProviders()}
              disabled={busy}
            >
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
          {busy
            ? 'Loading provider and model availability…'
            : 'No providers reported by the agent backend.'}
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
          <button
            type="button"
            className="agent-chip"
            onClick={onSetApiKey}
            disabled={busy || !apiKey.trim()}
          >
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
  const parsedAnswer = useMemo(
    () =>
      isUser
        ? { markdown: message.text, plan: null, planStreaming: false }
        : parseAgentAnswer(message.text),
    [isUser, message.text]
  )
  const hasActivity = Boolean(message.thinking || message.tools?.length)

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
      {parsedAnswer.plan && <AgentCleanupPlan plan={parsedAnswer.plan} />}
      {parsedAnswer.markdown &&
        (isUser ? (
          <div className="whitespace-pre-wrap leading-relaxed">{parsedAnswer.markdown}</div>
        ) : (
          <AgentMarkdown text={parsedAnswer.markdown} streaming={Boolean(message.streaming)} />
        ))}
      {parsedAnswer.planStreaming && (
        <div className="agent-plan-pending">
          <span aria-hidden="true" />
          Formatting cleanup candidates…
        </div>
      )}
      {!message.text && !message.status && !message.thinking && (
        <div className="text-[var(--viz-muted)]">…</div>
      )}
      {hasActivity && (
        <AgentActivityPanel
          thinking={message.thinking}
          tools={message.tools ?? []}
          active={Boolean(message.streaming && !message.text)}
        />
      )}
    </article>
  )
}

function AgentActivityPanel({
  thinking,
  tools,
  active
}: {
  thinking?: string
  tools: AgentToolTranscript[]
  active: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)

  return (
    <details
      open={active || open}
      onToggle={(event) => {
        if (!active) setOpen(event.currentTarget.open)
      }}
      className="mt-3 overflow-hidden rounded-lg border border-[var(--viz-rule)] bg-[var(--viz-field)]/45"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--viz-muted)]">
        <span>Agent activity</span>
        <span>
          {active
            ? 'Live'
            : `${tools.length} tool ${tools.length === 1 ? 'step' : 'steps'} · ${open ? 'Hide' : 'Show'}`}
        </span>
      </summary>
      <div className="max-h-64 space-y-2 overflow-auto border-t border-[var(--viz-rule)] p-2">
        {thinking && (
          <div className="rounded border border-[var(--viz-rule)] px-3 py-2 text-[11px] text-[var(--viz-muted)]">
            <p className="mb-1 font-mono text-[9px] uppercase tracking-[0.12em]">Reasoning</p>
            <AgentMarkdown text={thinking} streaming={active} />
          </div>
        )}
        {tools.map((tool) => (
          <AgentToolCard key={tool.id} tool={tool} />
        ))}
      </div>
    </details>
  )
}

const CLEANUP_TIER_META: Record<CleanupPlanTierId, { label: string; description: string }> = {
  easy: { label: 'Easy cleanup', description: 'Regenerable or disposable' },
  optional: { label: 'Optional', description: 'Review before removing' },
  keep: { label: 'Keep', description: 'Risky or valuable' }
}

const CLEANUP_ACTION_LABEL: Record<CleanupPlanAction, string> = {
  trash: 'Move to Trash',
  permanent: 'Permanently remove',
  keep: 'Keep'
}

function AgentCleanupPlan({ plan }: { plan: CleanupPlan }): React.JSX.Element {
  const candidateCount = plan.tiers
    .filter((tier) => tier.tier !== 'keep')
    .reduce((total, tier) => total + tier.items.length, 0)

  return (
    <section className="agent-cleanup-plan" aria-label="Cleanup candidates">
      <header className="agent-cleanup-plan__header">
        <div>
          <p className="agent-cleanup-plan__eyebrow">Cleanup candidates</p>
          <h3>{plan.summary || `${candidateCount} items ready to review`}</h3>
        </div>
        <div className="agent-cleanup-plan__total">
          <strong>{formatBytes(plan.knownCandidateBytes)}</strong>
          <span>
            {candidateCount} candidate{candidateCount === 1 ? '' : 's'}
            {plan.unknownCandidateCount > 0 ? ` · ${plan.unknownCandidateCount} size unknown` : ''}
          </span>
        </div>
      </header>

      {candidateCount === 0 && (
        <p className="agent-cleanup-plan__empty">No removable items were verified in this pass.</p>
      )}

      <div className="agent-cleanup-plan__tiers">
        {plan.tiers.map((tier) => {
          if (tier.items.length === 0) return null
          const meta = CLEANUP_TIER_META[tier.tier]
          return (
            <section key={tier.tier} className="agent-cleanup-tier" data-tier={tier.tier}>
              <header>
                <div>
                  <h4>{meta.label}</h4>
                  <p>{meta.description}</p>
                </div>
                <span>
                  {formatBytes(tier.knownBytes)}
                  {tier.unknownSizeCount > 0 ? ' + unknown' : ''}
                </span>
              </header>
              <div>
                {tier.items.map((item) => (
                  <CleanupPlanRow key={`${tier.tier}:${item.path}`} item={item} />
                ))}
              </div>
            </section>
          )
        })}
      </div>
      <p className="agent-cleanup-plan__note">
        Recommendations only · reveal an item to review it in Finder
      </p>
    </section>
  )
}

function CleanupPlanRow({ item }: { item: CleanupPlanItem }): React.JSX.Element {
  return (
    <article className="agent-cleanup-row">
      <div className="agent-cleanup-row__main">
        <div className="agent-cleanup-row__title">
          <strong>{item.name}</strong>
          <span>{item.sizeBytes === null ? 'Size unknown' : formatBytes(item.sizeBytes)}</span>
        </div>
        <p className="agent-cleanup-row__path" title={item.path}>
          {item.path}
        </p>
        <p className="agent-cleanup-row__reason">{item.reason}</p>
      </div>
      <div className="agent-cleanup-row__actions">
        <span data-action={item.action}>{CLEANUP_ACTION_LABEL[item.action]}</span>
        <button
          type="button"
          onClick={() => void window.api.shell.showItemInFolder(item.path)}
          disabled={!item.path.startsWith('/')}
        >
          Reveal
        </button>
      </div>
    </article>
  )
}

function AgentMarkdown({
  text,
  streaming
}: {
  text: string
  streaming: boolean
}): React.JSX.Element {
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

function AgentMarkdownLink(props: ComponentProps<'a'> & { node?: unknown }): React.JSX.Element {
  const { node, ...anchorProps } = props
  void node
  return <a {...anchorProps} target="_blank" rel="noreferrer noopener" />
}

function AgentToolCard({ tool }: { tool: AgentToolTranscript }): React.JSX.Element {
  // Auto-open while a step is running; allow toggle either way. Auto-collapse when it finishes.
  const [open, setOpen] = useState(() => tool.status === 'running')
  const [copied, setCopied] = useState(false)
  const prevStatusRef = useRef(tool.status)

  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = tool.status
    if (tool.status === 'running' && prev !== 'running') {
      setOpen(true)
    } else if (prev === 'running' && tool.status !== 'running') {
      setOpen(false)
    }
  }, [tool.status])

  const statusLabel =
    tool.status === 'running' ? 'Running' : tool.status === 'failed' ? 'Failed' : 'Done'
  const argsText = tool.argsText?.trim() ?? ''
  const outputText = tool.text?.trim() ?? ''
  const hasArgs = argsText.length > 0
  const hasOutput = outputText.length > 0
  const isCommandTool =
    tool.toolName === 'bash' || tool.toolName === 'shell' || tool.toolName === 'exec'
  const title = isCommandTool
    ? hasArgs
      ? truncateTitle(argsText, 72)
      : 'Terminal'
    : hasArgs
      ? `${tool.toolName} · ${truncateTitle(argsText.split('\n')[0] ?? '', 48)}`
      : tool.toolName
  const showRunningPlaceholder = tool.status === 'running' && !hasArgs && !hasOutput
  const copyPayload = [argsText, outputText].filter(Boolean).join('\n\n')

  const copyCard = async (): Promise<void> => {
    if (!copyPayload) return
    try {
      await navigator.clipboard.writeText(copyPayload)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }

  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="rounded border border-[var(--viz-rule)] px-3 py-2 font-mono text-[10px]"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[var(--viz-muted)]">
        <span className="min-w-0 truncate">{title}</span>
        <span className="shrink-0">{statusLabel}</span>
      </summary>
      <div className="mt-2 space-y-2 border-t border-[var(--viz-rule)] pt-2">
        {hasArgs ? (
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2 text-[var(--viz-muted)]">
              <span>{isCommandTool ? 'Command' : 'Args'}</span>
              <button
                type="button"
                className="rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wide hover:bg-[var(--viz-rule)]"
                onClick={(event) => {
                  event.preventDefault()
                  void copyCard()
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <pre className="agent-tool-scroll max-h-28 overflow-auto whitespace-pre-wrap break-all text-[var(--viz-ink)]">
              {argsText}
            </pre>
          </div>
        ) : null}
        {hasOutput ? (
          <div className="space-y-1">
            {!hasArgs ? (
              <div className="flex items-center justify-between gap-2 text-[var(--viz-muted)]">
                <span>Output</span>
                <button
                  type="button"
                  className="rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wide hover:bg-[var(--viz-rule)]"
                  onClick={(event) => {
                    event.preventDefault()
                    void copyCard()
                  }}
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            ) : (
              <span className="text-[var(--viz-muted)]">Output</span>
            )}
            <pre className="agent-tool-scroll max-h-48 overflow-auto whitespace-pre-wrap break-all text-[var(--viz-ink)]">
              {outputText}
            </pre>
          </div>
        ) : null}
        {showRunningPlaceholder ? <pre className="text-[var(--viz-muted)]">Running…</pre> : null}
        {!showRunningPlaceholder && !hasArgs && !hasOutput ? (
          <pre className="text-[var(--viz-muted)]">No output</pre>
        ) : null}
      </div>
    </details>
  )
}

function truncateTitle(value: string, max: number): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (compact.length <= max) return compact
  return `${compact.slice(0, Math.max(0, max - 1))}…`
}

function AgentIconBase({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

function AgentResetIcon(): React.JSX.Element {
  return (
    <AgentIconBase>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89" />
      <path d="M13.5 2.5v2.6h-2.6" />
    </AgentIconBase>
  )
}

function AgentMinimizeIcon(): React.JSX.Element {
  return (
    <AgentIconBase>
      <path d="M4 6l4 4 4-4" />
    </AgentIconBase>
  )
}

function AgentCloseIcon(): React.JSX.Element {
  return (
    <AgentIconBase>
      <path d="M4 4l8 8" />
      <path d="M12 4l-8 8" />
    </AgentIconBase>
  )
}

function AgentLogoutIcon(): React.JSX.Element {
  return (
    <AgentIconBase>
      <path d="M9.5 3.5H12a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 12 12.5H9.5" />
      <path d="M7 8H2.5" />
      <path d="M4.5 5.5 2 8l2.5 2.5" />
    </AgentIconBase>
  )
}

function AgentStopIcon(): React.JSX.Element {
  return (
    <AgentIconBase>
      <rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1.5" fill="currentColor" stroke="none" />
    </AgentIconBase>
  )
}

function AgentSendIcon(): React.JSX.Element {
  return (
    <AgentIconBase>
      <path d="M8 12.5v-9" />
      <path d="M4.25 7.25 8 3.5l3.75 3.75" />
    </AgentIconBase>
  )
}
