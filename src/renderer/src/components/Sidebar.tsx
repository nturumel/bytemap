import { SCAN_CATEGORIES } from '@shared/types'
import type { ScanCategoryId, ScanItem } from '@shared/types'
import { formatBytes } from '@shared/format'
import { AppWindowIcon, CopyIcon, FileStackIcon, ClockCacheIcon, DownloadIcon } from './icons'

const ICONS: Record<ScanCategoryId, (props: { className?: string }) => React.JSX.Element> = {
  unusedApps: AppWindowIcon,
  duplicates: CopyIcon,
  largeFiles: FileStackIcon,
  caches: ClockCacheIcon,
  oldDownloads: DownloadIcon
}

export function Sidebar({
  items,
  active,
  onSelect
}: {
  items: ScanItem[]
  active: ScanCategoryId | 'all'
  onSelect: (category: ScanCategoryId | 'all') => void
}): React.JSX.Element {
  const totalSize = items.reduce((sum, i) => sum + i.sizeBytes, 0)

  return (
    <nav className="flex h-full w-56 shrink-0 flex-col gap-0.5 border-r border-neutral-200 px-2 pb-4 pt-14 dark:border-neutral-800">
      <SidebarRow
        label="All items"
        count={items.length}
        size={totalSize}
        active={active === 'all'}
        onClick={() => onSelect('all')}
        icon={<SparkleAll />}
      />
      <div className="my-2 h-px bg-neutral-200 dark:bg-neutral-800" />
      {SCAN_CATEGORIES.map((c) => {
        const catItems = items.filter((i) => i.category === c.id)
        const Icon = ICONS[c.id]
        return (
          <SidebarRow
            key={c.id}
            label={c.label}
            count={catItems.length}
            size={catItems.reduce((sum, i) => sum + i.sizeBytes, 0)}
            active={active === c.id}
            onClick={() => onSelect(c.id)}
            icon={<Icon className="shrink-0" />}
          />
        )
      })}
    </nav>
  )
}

function SparkleAll(): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
    >
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  )
}

function SidebarRow({
  label,
  count,
  size,
  active,
  onClick,
  icon
}: {
  label: string
  count: number
  size: number
  active: boolean
  onClick: () => void
  icon: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={count === 0}
      className={`no-drag flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition disabled:opacity-30 ${
        active
          ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
          : 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900'
      }`}
    >
      <span className={active ? 'text-blue-500' : 'text-neutral-400 dark:text-neutral-500'}>
        {icon}
      </span>
      <span className="flex-1 truncate font-medium">{label}</span>
      {count > 0 && (
        <span className="shrink-0 text-xs tabular-nums text-neutral-400 dark:text-neutral-500">
          {formatBytes(size)}
        </span>
      )}
    </button>
  )
}
