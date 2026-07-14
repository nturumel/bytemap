import { useCallback, useEffect, useMemo, useState } from 'react'
import { useDiskUsage } from '../hooks/useDiskUsage'
import { Treemap, suggestedTargetPaths } from './Treemap'
import { TileActionPanel, nodeToScanItem } from './TileActionPanel'
import { ConfirmModal } from './ConfirmModal'
import { formatBytes } from '@shared/format'
import { SpinnerIcon } from './icons'
import { classifyPath } from '@shared/cleanupTargets'
import type { DiskNode, PrivilegedHelperState, ScanItem } from '@shared/types'
import { HELPER_REQUIRED } from '@shared/types'

const LEGEND: { label: string; varName: string }[] = [
  { label: 'Folder', varName: '--viz-dir' },
  { label: 'File', varName: '--viz-file' },
  { label: 'Cache', varName: '--viz-cache' },
  { label: 'Library', varName: '--viz-bundle' },
  { label: 'Safe', varName: '--viz-target-safe' },
  { label: 'Caution', varName: '--viz-target-caution' }
]

export function DiskUsageScreen({ onBack }: { onBack: () => void }): React.JSX.Element {
  const {
    breadcrumbs,
    children,
    loading,
    refreshing,
    selectedPath,
    setSelectedPath,
    drillInto,
    goToBreadcrumb,
    refresh,
    removeChild
  } = useDiskUsage()

  const [helperState, setHelperState] = useState<PrivilegedHelperState | null>(null)
  const [confirmItem, setConfirmItem] = useState<ScanItem | null>(null)
  const [busy, setBusy] = useState(false)
  const [ignored, setIgnored] = useState<Set<string>>(() => new Set())
  const [suggestIndex, setSuggestIndex] = useState(-1)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)

  const totalSize = children.reduce((sum, n) => sum + n.size, 0)
  const selectedNode = useMemo(
    () => children.find((n) => n.path === selectedPath) ?? null,
    [children, selectedPath]
  )

  const visibleChildren = useMemo(
    () => children.filter((n) => !ignored.has(n.path)),
    [children, ignored]
  )

  const suggestions = useMemo(
    () => suggestedTargetPaths(visibleChildren).filter((p) => !ignored.has(p)),
    [visibleChildren, ignored]
  )

  const highlightPath =
    suggestIndex >= 0 && suggestIndex < suggestions.length ? suggestions[suggestIndex] : null

  useEffect(() => {
    window.api.helper
      .status()
      .then(setHelperState)
      .catch(() =>
        setHelperState({ status: 'unavailable', ctlAvailable: false, canRegister: false })
      )
  }, [])

  const selectNode = useCallback(
    (node: DiskNode) => {
      setSelectedPath(node.path)
      setSuggestIndex(-1)
      setStatusMsg(null)
    },
    [setSelectedPath]
  )

  const cycleSuggestions = useCallback(() => {
    if (suggestions.length === 0) {
      setStatusMsg('No reclaim targets in this view')
      return
    }
    setSuggestIndex((i) => {
      const next = i < 0 ? 0 : (i + 1) % suggestions.length
      setSelectedPath(suggestions[next])
      setStatusMsg(`Target ${next + 1} of ${suggestions.length} — N next`)
      return next
    })
  }, [suggestions, setSelectedPath])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return

      if (e.key === 'n' || e.key === 'N') {
        if (e.metaKey || e.ctrlKey || e.altKey) return
        e.preventDefault()
        cycleSuggestions()
        return
      }
      if (e.key === 'Escape') {
        setSelectedPath(null)
        setSuggestIndex(-1)
        setConfirmItem(null)
        return
      }
      if ((e.key === 'Backspace' || e.key === 'Delete') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (!selectedNode || confirmItem || busy) return
        const target = classifyPath(selectedNode.path, selectedNode.name)
        if (target?.tier === 'protected' || target?.primaryAction === 'inspectOnly') {
          setStatusMsg('Protected — open in Finder instead')
          return
        }
        e.preventDefault()
        setConfirmItem(nodeToScanItem(selectedNode, target, 'trash'))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cycleSuggestions, setSelectedPath, selectedNode, confirmItem, busy])

  const queueAction = useCallback(
    (node: DiskNode, kind: 'remove' | 'trash') => {
      const target = classifyPath(node.path, node.name)
      if (target?.tier === 'protected' || target?.primaryAction === 'inspectOnly') {
        setStatusMsg('Protected — open in Finder instead')
        return
      }
      if (kind === 'remove' && target?.primaryAction !== 'clearCache') {
        setStatusMsg('Permanent clear only available for known caches')
        return
      }
      setConfirmItem(nodeToScanItem(node, target, kind))
    },
    []
  )

  const runDelete = useCallback(async () => {
    if (!confirmItem) return
    setBusy(true)
    setStatusMsg(null)
    try {
      await window.api.disk.expectChanges([confirmItem.path])
      let results = await window.api.deleteItems({
        items: [{ id: confirmItem.id, path: confirmItem.path, action: confirmItem.action }]
      })
      const needsHelper = results.some((r) => !r.ok && r.error === HELPER_REQUIRED)
      if (needsHelper && helperState?.canRegister) {
        const state = await window.api.helper.register()
        setHelperState(state)
        if (state.status === 'enabled') {
          results = await window.api.deleteHelperItems({
            items: [{ id: confirmItem.id, path: confirmItem.path, action: confirmItem.action }]
          })
        }
      }
      const ok = results.every((r) => r.ok)
      if (ok) {
        removeChild(confirmItem.path)
        setSelectedPath(null)
        setStatusMsg(`Cleared ${confirmItem.name}`)
        // Watcher + expectChanges will SWR-refresh; avoid a second force load.
      } else {
        setStatusMsg(results.find((r) => !r.ok)?.error ?? 'Could not delete')
      }
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setConfirmItem(null)
      setBusy(false)
    }
  }, [confirmItem, helperState, removeChild, setSelectedPath])

  return (
    <div className="viz-shell flex h-full flex-col">
      <header className="drag-region flex shrink-0 items-center justify-between border-b border-[var(--viz-rule)] px-5 pb-3 pt-11">
        <div className="min-w-0">
          <div className="flex items-center gap-1 font-display text-sm font-semibold tracking-wide">
            {breadcrumbs.map((b, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <span className="text-[var(--viz-muted)]">/</span>}
                <button
                  onClick={() => goToBreadcrumb(i)}
                  className={`no-drag rounded px-1 hover:bg-black/5 dark:hover:bg-white/5 ${
                    i === breadcrumbs.length - 1 ? 'text-[var(--viz-ink)]' : 'text-[var(--viz-muted)]'
                  }`}
                >
                  {b.name}
                </button>
              </span>
            ))}
          </div>
          <p className="mt-0.5 font-mono text-[11px] tabular-nums text-[var(--viz-muted)]">
            {formatBytes(totalSize)} shown
            {loading && ` — measuring (${children.length})…`}
            {refreshing && !loading && ' — updating…'}
            {statusMsg && ` · ${statusMsg}`}
          </p>
        </div>
        <div className="no-drag flex items-center gap-2">
          <button
            type="button"
            onClick={cycleSuggestions}
            className="viz-kbd"
            title="Cycle reclaim targets in this view"
          >
            N targets
            {suggestions.length > 0 ? ` · ${suggestions.length}` : ''}
          </button>
          <button
            type="button"
            onClick={refresh}
            className="rounded px-3 py-1.5 text-xs font-medium text-[var(--viz-muted)] hover:bg-black/5 dark:hover:bg-white/5"
          >
            Refresh
          </button>
          <button type="button" onClick={onBack} className="viz-back">
            Cleanup scan
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1 p-3">
          {children.length === 0 && loading ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-[var(--viz-muted)]">
              <SpinnerIcon width={22} height={22} />
              <p className="font-mono text-sm">Measuring…</p>
            </div>
          ) : visibleChildren.length === 0 ? (
            <p className="mt-10 text-center font-mono text-sm text-[var(--viz-muted)]">
              Nothing here.
            </p>
          ) : (
            <Treemap
              nodes={visibleChildren}
              selectedPath={selectedPath}
              highlightPath={highlightPath}
              onSelect={selectNode}
              onActivate={drillInto}
            />
          )}
          {refreshing && (
            <div className="pointer-events-none absolute right-5 top-5 rounded bg-[var(--viz-panel)]/90 px-2 py-1 font-mono text-[10px] text-[var(--viz-muted)] shadow">
              Revalidating
            </div>
          )}
        </div>

        {selectedNode && (
          <TileActionPanel
            node={selectedNode}
            viewTotal={totalSize}
            helperState={helperState}
            busy={busy}
            onDrill={() => drillInto(selectedNode)}
            onClear={() => queueAction(selectedNode, 'remove')}
            onTrash={() => queueAction(selectedNode, 'trash')}
            onReveal={() => {
              void window.api.shell.showItemInFolder(selectedNode.path)
            }}
            onIgnore={() => {
              setIgnored((prev) => new Set(prev).add(selectedNode.path))
              setSelectedPath(null)
            }}
            onClose={() => setSelectedPath(null)}
          />
        )}
      </div>

      <div className="flex shrink-0 items-center gap-4 border-t border-[var(--viz-rule)] px-5 py-2">
        {LEGEND.map((l) => (
          <div
            key={l.label}
            className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--viz-muted)]"
          >
            <span
              className="h-2 w-2 rounded-[1px]"
              style={{ backgroundColor: `var(${l.varName})` }}
            />
            {l.label}
          </div>
        ))}
        <span className="ml-auto font-mono text-[10px] text-[var(--viz-muted)]">
          Click select · double-click drill · N targets · ⌫ trash
        </span>
      </div>

      {confirmItem && (
        <ConfirmModal
          items={[confirmItem]}
          helperState={helperState}
          onCancel={() => setConfirmItem(null)}
          onConfirm={() => {
            void runDelete()
          }}
        />
      )}
    </div>
  )
}
