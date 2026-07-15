import { SCAN_CATEGORIES } from '@shared/types'
import type { ScanCategoryId, ScanItem } from '@shared/types'
import { SpinnerIcon, CheckCircleIcon } from './icons'

export function ScanningScreen({
  messages,
  categoriesDone,
  items
}: {
  messages: Record<ScanCategoryId, string>
  categoriesDone: Set<ScanCategoryId>
  items: ScanItem[]
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="m-auto flex w-full flex-col items-center px-10 py-8 text-center">
        <SpinnerIcon width={28} height={28} className="text-blue-500" />
        <h1 className="mt-5 text-xl font-semibold">Scanning…</h1>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          Running all checks at once
        </p>

        <div className="mt-8 w-full max-w-md space-y-1.5 text-left">
          {SCAN_CATEGORIES.map((c) => {
            const done = categoriesDone.has(c.id)
            const count = items.filter((i) => i.category === c.id).length
            return (
              <div key={c.id} className="rounded-lg px-3 py-2 text-sm">
                <div className="flex items-center justify-between">
                  <span
                    className={
                      done
                        ? 'text-neutral-900 dark:text-neutral-100'
                        : 'text-neutral-400 dark:text-neutral-600'
                    }
                  >
                    {c.label}
                  </span>
                  {done ? (
                    <span className="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                      {count} found
                      <CheckCircleIcon width={14} height={14} className="text-emerald-500" />
                    </span>
                  ) : (
                    <SpinnerIcon
                      width={14}
                      height={14}
                      className="text-neutral-300 dark:text-neutral-700"
                    />
                  )}
                </div>
                {!done && messages[c.id] && (
                  <div className="mt-0.5 truncate text-xs text-neutral-400 dark:text-neutral-600">
                    {messages[c.id]}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
