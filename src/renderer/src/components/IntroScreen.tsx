import { SCAN_CATEGORIES } from '@shared/types'
import { AppWindowIcon, CopyIcon, FileStackIcon, ClockCacheIcon, DownloadIcon } from './icons'
import { FullDiskAccessBanner } from './FullDiskAccessBanner'
import type { ScanCategoryId } from '@shared/types'

const ICONS: Record<ScanCategoryId, (props: { className?: string }) => React.JSX.Element> = {
  unusedApps: AppWindowIcon,
  duplicates: CopyIcon,
  largeFiles: FileStackIcon,
  caches: ClockCacheIcon,
  oldDownloads: DownloadIcon
}

export function IntroScreen({
  onStart,
  onShowDiskUsage
}: {
  onStart: () => void
  onShowDiskUsage: () => void
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center px-10 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-500/10 text-blue-500">
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 3" strokeLinecap="round" />
        </svg>
      </div>
      <h1 className="mt-5 text-xl font-semibold">Find space to free up</h1>
      <p className="mt-2 max-w-sm text-sm text-neutral-500 dark:text-neutral-400">
        Scans your home folder and Applications for things you probably don&apos;t need anymore.
        Nothing is deleted until you review and confirm.
      </p>

      <div className="mt-8 grid w-full max-w-md grid-cols-1 gap-2 text-left">
        {SCAN_CATEGORIES.map((c) => {
          const Icon = ICONS[c.id]
          return (
            <div
              key={c.id}
              className="flex items-center gap-3 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2.5 dark:border-neutral-800 dark:bg-neutral-900"
            >
              <Icon className="shrink-0 text-neutral-500 dark:text-neutral-400" />
              <div>
                <div className="text-sm font-medium">{c.label}</div>
                <div className="text-xs text-neutral-500 dark:text-neutral-400">
                  {c.description}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <FullDiskAccessBanner />

      <div className="mt-8 flex items-center gap-3">
        <button
          onClick={onStart}
          className="no-drag rounded-full bg-blue-500 px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-600 active:scale-[0.98]"
        >
          Scan for space to free
        </button>
        <button
          onClick={onShowDiskUsage}
          className="no-drag rounded-full px-4 py-2.5 text-sm font-medium text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-900"
        >
          Visualize disk usage
        </button>
      </div>
    </div>
  )
}
