import { useState } from 'react'
import type { DiskNode, PrivilegedHelperState, ScanItem } from '@shared/types'
import { formatBytes } from '@shared/format'
import { classifyPath, type CleanupTarget } from '@shared/cleanupTargets'

function canTrash(target: CleanupTarget | null): boolean {
  if (!target) return true
  return target.primaryAction !== 'inspectOnly' && target.tier !== 'protected'
}

function canClear(target: CleanupTarget | null): boolean {
  return target?.primaryAction === 'clearCache'
}

export function TileActionPanel({
  node,
  viewTotal,
  helperState,
  busy,
  onDrill,
  onClear,
  onTrash,
  onReveal,
  onIgnore,
  onClose
}: {
  node: DiskNode
  viewTotal: number
  helperState: PrivilegedHelperState | null
  busy: boolean
  onDrill: () => void
  onClear: () => void
  onTrash: () => void
  onReveal: () => void
  onIgnore: () => void
  onClose: () => void
}): React.JSX.Element {
  const target: CleanupTarget | null = classifyPath(node.path, node.name)
  const trashOk = canTrash(target)
  const clearOk = canClear(target)
  const share =
    viewTotal > 0 ? Math.max(0.1, Math.round((node.size / viewTotal) * 1000) / 10) : null
  const [copied, setCopied] = useState(false)

  const copyPath = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(node.path)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      setCopied(false)
    }
  }

  return (
    <aside className="viz-sidepanel no-drag flex w-[320px] shrink-0 flex-col border-l border-[var(--viz-rule)] bg-[var(--viz-panel)]">
      <div className="flex items-start justify-between gap-2 border-b border-[var(--viz-rule)] px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="font-display text-[13px] font-semibold tracking-wide text-[var(--viz-ink)]">
              {node.name}
            </p>
            <span className="viz-meta-pill">{node.isDir ? 'Folder' : 'File'}</span>
            {target && (
              <span className="viz-meta-pill" data-tier={target.tier}>
                {target.label}
              </span>
            )}
          </div>
          <p className="mt-1 break-all font-mono text-[10px] leading-snug text-[var(--viz-muted)]">
            {node.path}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded px-1.5 py-0.5 text-xs text-[var(--viz-muted)] hover:bg-black/5 dark:hover:bg-white/5"
          aria-label="Close"
        >
          Esc
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
        <div className="grid grid-cols-2 gap-2">
          <div className="viz-stat">
            <span className="viz-stat__label">Size</span>
            <span className="viz-stat__value">{formatBytes(node.size)}</span>
          </div>
          <div className="viz-stat">
            <span className="viz-stat__label">Of this view</span>
            <span className="viz-stat__value">{share != null ? `${share}%` : '—'}</span>
          </div>
        </div>

        {target ? (
          <div className="viz-callout" data-tier={target.tier}>
            <div className="text-[11px] font-semibold uppercase tracking-wider">{target.label}</div>
            <p className="mt-1 text-[12px] leading-snug text-[var(--viz-ink)]/90">{target.reason}</p>
            {trashOk && (
              <p className="mt-2 font-mono text-[11px] tabular-nums text-[var(--viz-muted)]">
                Reclaim up to {formatBytes(node.size)}
              </p>
            )}
          </div>
        ) : (
          <div className="viz-callout" data-tier="inspect">
            <div className="text-[11px] font-semibold uppercase tracking-wider">Manual review</div>
            <p className="mt-1 text-[12px] leading-snug text-[var(--viz-ink)]/90">
              No automatic reclaim rule for this tile. Drill in to hunt caches, or trash it after
              you confirm it is disposable.
            </p>
            <p className="mt-2 font-mono text-[11px] tabular-nums text-[var(--viz-muted)]">
              Could free {formatBytes(node.size)}
            </p>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--viz-muted)]">
            Optimize
          </p>
          {clearOk && (
            <button
              type="button"
              className="viz-action viz-action--safe"
              onClick={onClear}
              disabled={busy}
            >
              <span>Clear cache</span>
              <span className="viz-action__hint">permanent · {formatBytes(node.size)}</span>
            </button>
          )}
          {trashOk ? (
            <button
              type="button"
              className={`viz-action ${clearOk ? 'viz-action--caution' : 'viz-action--primary'}`}
              onClick={onTrash}
              disabled={busy}
            >
              <span>Move to Trash</span>
              <span className="viz-action__hint">⌫ · recoverable</span>
            </button>
          ) : (
            <p className="rounded border border-dashed border-[var(--viz-rule)] px-2.5 py-2 text-[11px] leading-snug text-[var(--viz-muted)]">
              Protected — Bytemap will not bulk-delete this path. Open in Finder if you must act.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--viz-muted)]">
            Navigate
          </p>
          {node.isDir && (
            <button type="button" className="viz-action viz-action--nav" onClick={onDrill} disabled={busy}>
              <span>Drill into folder</span>
              <span className="viz-action__hint">double-click</span>
            </button>
          )}
          <button type="button" className="viz-action" onClick={onReveal} disabled={busy}>
            Open in Finder
          </button>
          <button type="button" className="viz-action" onClick={() => void copyPath()} disabled={busy}>
            {copied ? 'Path copied' : 'Copy path'}
          </button>
        </div>

        <div className="mt-auto flex flex-col gap-1.5 pt-1">
          <button type="button" className="viz-action viz-action--ghost" onClick={onIgnore}>
            Ignore in this view
          </button>
          {helperState && helperState.status !== 'enabled' && helperState.canRegister && (
            <p className="text-[10px] leading-snug text-[var(--viz-muted)]">
              Protected paths may prompt once to install Bytemap’s helper.
            </p>
          )}
        </div>
      </div>
    </aside>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function nodeToScanItem(
  node: DiskNode,
  target: CleanupTarget | null,
  kind: 'remove' | 'trash'
): ScanItem {
  const reason =
    target?.reason ??
    (node.isDir
      ? 'Selected folder — confirm before deleting'
      : 'Selected file — confirm before deleting')
  return {
    id: `viz:${node.path}`,
    path: node.path,
    name: node.name,
    sizeBytes: node.size,
    reason,
    category: target?.primaryAction === 'clearCache' ? 'caches' : 'largeFiles',
    action: { kind }
  }
}
