import { useDiskUsage } from '../hooks/useDiskUsage'
import { Treemap } from './Treemap'
import { formatBytes } from '@shared/format'
import { SpinnerIcon } from './icons'

const LEGEND: { label: string; varName: string }[] = [
  { label: 'Folder', varName: '--viz-dir' },
  { label: 'File', varName: '--viz-file' },
  { label: 'Cache / regenerable', varName: '--viz-cache' },
  { label: 'App-managed library', varName: '--viz-bundle' }
]

export function DiskUsageScreen({ onBack }: { onBack: () => void }): React.JSX.Element {
  const { breadcrumbs, children, loading, drillInto, goToBreadcrumb, refresh } = useDiskUsage()
  const totalSize = children.reduce((sum, n) => sum + n.size, 0)

  return (
    <div className="flex h-full flex-col">
      <header className="drag-region flex shrink-0 items-center justify-between border-b border-neutral-200 px-5 pb-3 pt-11 dark:border-neutral-800">
        <div className="min-w-0">
          <div className="flex items-center gap-1 text-sm font-semibold">
            {breadcrumbs.map((b, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <span className="text-neutral-400">/</span>}
                <button
                  onClick={() => goToBreadcrumb(i)}
                  className={`no-drag rounded px-1 hover:bg-neutral-100 dark:hover:bg-neutral-900 ${
                    i === breadcrumbs.length - 1 ? '' : 'text-neutral-500 dark:text-neutral-400'
                  }`}
                >
                  {b.name}
                </button>
              </span>
            ))}
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {formatBytes(totalSize)} shown
            {loading && ` — scanning (${children.length} so far)…`}
          </p>
        </div>
        <div className="no-drag flex items-center gap-3">
          <button
            onClick={refresh}
            className="rounded-full px-3 py-1.5 text-xs font-medium text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-900"
          >
            Refresh
          </button>
          <button
            onClick={onBack}
            className="rounded-full bg-blue-500 px-4 py-1.5 text-xs font-semibold text-white hover:bg-blue-600 active:scale-[0.98]"
          >
            Back to cleanup
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 p-4">
        {children.length === 0 && loading ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-neutral-400">
            <SpinnerIcon width={22} height={22} />
            <p className="text-sm">Measuring…</p>
          </div>
        ) : children.length === 0 ? (
          <p className="mt-10 text-center text-sm text-neutral-400">Nothing here.</p>
        ) : (
          <Treemap nodes={children} onSelect={drillInto} />
        )}
      </div>

      <div className="flex shrink-0 items-center gap-4 border-t border-neutral-200 px-5 py-2.5 dark:border-neutral-800">
        {LEGEND.map((l) => (
          <div
            key={l.label}
            className="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400"
          >
            <span
              className="h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: `var(${l.varName})` }}
            />
            {l.label}
          </div>
        ))}
        <span className="ml-auto text-xs text-neutral-400 dark:text-neutral-600">
          Click a folder to drill in
        </span>
      </div>
    </div>
  )
}
