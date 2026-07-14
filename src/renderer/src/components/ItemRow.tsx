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
  return (
    <label className="group box-border flex h-full cursor-pointer items-center gap-3 border-b border-neutral-100 px-3 hover:bg-neutral-100 dark:border-neutral-900 dark:hover:bg-neutral-900">
      <input
        type="checkbox"
        checked={checked}
        onChange={() => onToggle(item.id)}
        className="h-4 w-4 shrink-0 accent-blue-500"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{item.name}</div>
        <div className="truncate font-mono text-xs text-neutral-400 dark:text-neutral-500">
          {item.path}
        </div>
      </div>
      <span className="hidden shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-500 group-hover:bg-white dark:bg-neutral-800 dark:text-neutral-400 dark:group-hover:bg-neutral-950 sm:block">
        {item.reason}
      </span>
      <span className="w-16 shrink-0 text-right text-sm tabular-nums text-neutral-600 dark:text-neutral-400">
        {formatBytes(item.sizeBytes)}
      </span>
    </label>
  )
}
