import type { DeleteResult } from '@shared/types'
import { formatBytes } from '@shared/format'
import { CheckCircleIcon, WarningIcon } from './icons'

export function DoneScreen({
  results,
  freedBytes,
  hadIrreversibleActions,
  onRescan,
  onBackToResults
}: {
  results: DeleteResult[]
  freedBytes: number
  hadIrreversibleActions: boolean
  onRescan: () => void
  onBackToResults: () => void
}): React.JSX.Element {
  const failures = results.filter((r) => !r.ok)

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="m-auto flex w-full flex-col items-center px-10 py-8 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-500">
          <CheckCircleIcon width={28} height={28} />
        </div>
        <h1 className="mt-5 text-xl font-semibold">Freed up {formatBytes(freedBytes)}</h1>
        <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
          {hadIrreversibleActions
            ? 'Files went to the Trash (recoverable); Docker items were pruned directly and can’t be undone.'
            : 'Moved to Trash — restore from there anytime before you empty it.'}
        </p>

        {failures.length > 0 && (
          <div className="mt-6 w-full max-w-md rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-left">
            <div className="flex items-center gap-2 text-xs font-semibold text-amber-600 dark:text-amber-400">
              <WarningIcon width={14} height={14} />
              {failures.length} item{failures.length === 1 ? '' : 's'} couldn&apos;t be deleted
            </div>
            <ul className="mt-2 max-h-48 space-y-2 overflow-y-auto">
              {failures.map((f) => (
                <li key={f.id} className="text-left text-xs text-neutral-500 dark:text-neutral-400">
                  <div className="truncate font-mono" title={f.path}>
                    {f.path}
                  </div>
                  {f.error && (
                    <div className="mt-0.5 text-[11px] leading-snug text-amber-700 dark:text-amber-400">
                      {f.error}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-8 flex gap-3">
          {failures.length > 0 && (
            <button
              onClick={onBackToResults}
              className="rounded-full px-5 py-2.5 text-sm font-medium text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900"
            >
              Back to list
            </button>
          )}
          <button
            onClick={onRescan}
            className="rounded-full bg-blue-500 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-600 active:scale-[0.98]"
          >
            Scan again
          </button>
        </div>
      </div>
    </div>
  )
}
