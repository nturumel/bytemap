import type { ScanItem } from '@shared/types'
import { formatBytes } from '@shared/format'

export function ItemRow({
  item,
  checked,
  onToggle
}: {
  item: ScanItem
  checked: boolean
  onToggle: (id: string) => void
}): React.JSX.Element {
  const deletable = item.deletable !== false

  return (
    <label
      className={`group box-border flex h-full items-center gap-3 border-b border-neutral-100 px-3 dark:border-neutral-900 ${
        deletable
          ? 'cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-900'
          : 'cursor-not-allowed opacity-60'
      }`}
    >
      <input
        type="checkbox"
        checked={deletable ? checked : false}
        disabled={!deletable}
        onChange={() => {
          if (deletable) onToggle(item.id)
        }}
        className="h-4 w-4 shrink-0 accent-blue-500 disabled:cursor-not-allowed"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{item.name}</div>
        <div className="truncate font-mono text-xs text-neutral-400 dark:text-neutral-500">
          {item.path}
        </div>
      </div>
      <span
        className={`hidden max-w-[14rem] shrink-0 truncate rounded-full px-2 py-0.5 text-xs sm:block ${
          deletable
            ? 'bg-neutral-100 text-neutral-500 group-hover:bg-white dark:bg-neutral-800 dark:text-neutral-400 dark:group-hover:bg-neutral-950'
            : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
        }`}
        title={item.reason}
      >
        {deletable ? item.reason : 'Protected by macOS — use Xcode Platforms'}
      </span>
      <span className="w-16 shrink-0 text-right text-sm tabular-nums text-neutral-600 dark:text-neutral-400">
        {formatBytes(item.sizeBytes)}
      </span>
    </label>
  )
}
