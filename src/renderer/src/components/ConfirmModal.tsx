import { SCAN_CATEGORIES } from '@shared/types'
import type { PrivilegedHelperState, ScanItem } from '@shared/types'
import { formatBytes } from '@shared/format'
import { WarningIcon } from './icons'

const DOCKER_COMMAND: Record<string, string> = {
  images: 'docker image prune',
  containers: 'docker container prune',
  volumes: 'docker volume prune',
  buildCache: 'docker builder prune'
}

function itemLocation(item: ScanItem): string {
  if (item.action?.kind === 'dockerPrune') return `runs ${DOCKER_COMMAND[item.action.target]}`
  return item.path
}

function actionKind(item: ScanItem): 'trash' | 'remove' | 'dockerPrune' {
  if (item.action?.kind === 'dockerPrune') return 'dockerPrune'
  if (item.action?.kind === 'remove') return 'remove'
  return 'trash'
}

// Selections regularly run into the thousands (duplicate-heavy scans) — listing every path
// would both flood the DOM and be unreadable to a human confirming a delete anyway.
const MAX_LISTED_PER_CATEGORY = 30

export function ConfirmModal({
  items,
  helperState,
  onCancel,
  onConfirm
}: {
  items: ScanItem[]
  helperState: PrivilegedHelperState | null
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const totalSize = items.reduce((sum, i) => sum + i.sizeBytes, 0)
  const trashCount = items.filter((i) => actionKind(i) === 'trash').length
  const removeCount = items.filter((i) => actionKind(i) === 'remove').length
  const dockerCount = items.filter((i) => actionKind(i) === 'dockerPrune').length
  const helperReady = helperState?.status === 'enabled'
  const helperAvailable = helperState?.canRegister === true

  const parts: string[] = []
  if (trashCount > 0) {
    parts.push(
      `${trashCount} item${trashCount === 1 ? '' : 's'} go to the Trash (recoverable` +
        (helperReady ? '; protected paths use the installed helper)' : ')')
    )
  }
  if (removeCount > 0) {
    parts.push(
      `${removeCount} cache/log item${removeCount === 1 ? '' : 's'} are permanently deleted`
    )
  }
  if (dockerCount > 0) {
    parts.push(
      `${dockerCount} Docker prune${dockerCount === 1 ? '' : 's'} cannot be undone`
    )
  }
  if (helperAvailable && !helperReady) {
    parts.push(
      'If any path needs admin rights, Bytemap will ask once to install a protected-file helper'
    )
  } else if (!helperReady && helperState && !helperAvailable) {
    parts.push(
      'Protected paths may ask for your admin password once (helper install needs a signed build)'
    )
  }

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/40 p-6">
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-2xl bg-white shadow-2xl dark:bg-neutral-900">
        <div className="flex items-start gap-3 border-b border-neutral-200 p-5 dark:border-neutral-800">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-amber-500">
            <WarningIcon width={18} height={18} />
          </div>
          <div>
            <h2 className="text-sm font-semibold">
              Clean up {items.length} item{items.length === 1 ? '' : 's'}?
            </h2>
            <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
              Frees up {formatBytes(totalSize)}. {parts.join('. ')}.
            </p>
            {helperAvailable && (
              <p className="mt-1 text-[11px] text-neutral-400 dark:text-neutral-500">
                Protected-file helper:{' '}
                {helperReady ? 'installed' : 'not installed yet'}
              </p>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {SCAN_CATEGORIES.map((meta) => {
            const catItems = items.filter((i) => i.category === meta.id)
            if (catItems.length === 0) return null
            const shown = catItems.slice(0, MAX_LISTED_PER_CATEGORY)
            const hiddenCount = catItems.length - shown.length
            return (
              <div key={meta.id} className="mb-2">
                <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-600">
                  {meta.label} · {catItems.length}
                </div>
                {shown.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center gap-2 rounded-md px-2 py-1 text-xs"
                  >
                    <span className="truncate font-mono text-neutral-500 dark:text-neutral-400">
                      {itemLocation(item)}
                    </span>
                    <span className="ml-auto shrink-0 tabular-nums text-neutral-400 dark:text-neutral-600">
                      {formatBytes(item.sizeBytes)}
                    </span>
                  </div>
                ))}
                {hiddenCount > 0 && (
                  <div className="px-2 py-1 text-xs italic text-neutral-400 dark:text-neutral-600">
                    …and {hiddenCount} more
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <div className="flex justify-end gap-2 border-t border-neutral-200 p-4 dark:border-neutral-800">
          <button
            onClick={onCancel}
            className="rounded-full px-4 py-1.5 text-sm font-medium text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="rounded-full bg-red-500 px-4 py-1.5 text-sm font-semibold text-white hover:bg-red-600 active:scale-[0.98]"
          >
            Clean Up
          </button>
        </div>
      </div>
    </div>
  )
}
