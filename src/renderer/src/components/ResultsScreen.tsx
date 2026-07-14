import { useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { SCAN_CATEGORIES } from '@shared/types'
import type { ScanCategoryId, ScanItem } from '@shared/types'
import { formatBytes } from '@shared/format'
import { Sidebar } from './Sidebar'
import { ItemRow } from './ItemRow'
import { ConfirmModal } from './ConfirmModal'
import type { PrivilegedHelperState } from '@shared/types'

const ITEM_HEIGHT = 57
const HEADER_HEIGHT = 36

type Row =
  | { type: 'header'; category: ScanCategoryId; label: string; count: number; allChecked: boolean }
  | { type: 'item'; item: ScanItem }

export function ResultsScreen({
  items,
  selected,
  helperState,
  onToggleItem,
  onToggleCategory,
  onConfirmDelete,
  onRescan,
  onShowDiskUsage
}: {
  items: ScanItem[]
  selected: Set<string>
  helperState: PrivilegedHelperState | null
  onToggleItem: (id: string) => void
  onToggleCategory: (category: ScanCategoryId, checked: boolean) => void
  onConfirmDelete: () => void
  onRescan: () => void
  onShowDiskUsage: () => void
}): React.JSX.Element {
  const [active, setActive] = useState<ScanCategoryId | 'all'>('all')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const visibleCategories = useMemo(
    () => (active === 'all' ? SCAN_CATEGORIES.map((c) => c.id) : [active]),
    [active]
  )

  const selectedItems = items.filter((i) => selected.has(i.id))
  const selectedSize = selectedItems.reduce((sum, i) => sum + i.sizeBytes, 0)

  // A flat row list — one entry per category header, one per item — lets the virtualizer
  // window over everything uniformly instead of mounting every row into the DOM. With
  // scans regularly surfacing tens of thousands of duplicates, un-virtualized rendering
  // made every checkbox click re-render the whole list.
  const rows = useMemo(() => {
    const result: Row[] = []
    for (const catId of visibleCategories) {
      const meta = SCAN_CATEGORIES.find((c) => c.id === catId)!
      const catItems = items.filter((i) => i.category === catId)
      if (catItems.length === 0) continue
      result.push({
        type: 'header',
        category: catId,
        label: meta.label,
        count: catItems.length,
        allChecked: catItems.every((i) => selected.has(i.id))
      })
      for (const item of catItems) result.push({ type: 'item', item })
    }
    return result
  }, [items, visibleCategories, selected])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i].type === 'header' ? HEADER_HEIGHT : ITEM_HEIGHT),
    overscan: 12
  })

  return (
    <div className="flex h-full flex-col">
      <header className="drag-region flex shrink-0 items-center justify-between border-b border-neutral-200 px-5 pb-3 pt-11 dark:border-neutral-800">
        <div>
          <h1 className="text-sm font-semibold">{items.length} things you could clean up</h1>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Nothing is deleted until you confirm below
          </p>
        </div>
        <div className="no-drag flex items-center gap-3">
          <button
            onClick={onShowDiskUsage}
            className="rounded-full px-3 py-1.5 text-xs font-medium text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-900"
          >
            Disk usage
          </button>
          <button
            onClick={onRescan}
            className="rounded-full px-3 py-1.5 text-xs font-medium text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-900"
          >
            Rescan
          </button>
          <button
            disabled={selectedItems.length === 0}
            onClick={() => setConfirmOpen(true)}
            className="rounded-full bg-blue-500 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-blue-600 active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-neutral-300 disabled:text-neutral-500 dark:disabled:bg-neutral-800 dark:disabled:text-neutral-600"
          >
            {selectedItems.length > 0
              ? `Clean up ${selectedItems.length} (${formatBytes(selectedSize)})`
              : 'Select items to delete'}
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <Sidebar items={items} active={active} onSelect={setActive} />

        <main ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4">
          {items.length === 0 && (
            <p className="mt-10 text-center text-sm text-neutral-400">
              Nothing flagged — your Mac looks tidy.
            </p>
          )}

          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index]
              return (
                <div
                  key={virtualRow.key}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: virtualRow.size,
                    transform: `translateY(${virtualRow.start}px)`
                  }}
                >
                  {row.type === 'header' ? (
                    <div className="flex h-full items-center gap-2.5 px-3 py-1.5">
                      <input
                        type="checkbox"
                        checked={row.allChecked}
                        onChange={(e) => onToggleCategory(row.category, e.target.checked)}
                        className="h-3.5 w-3.5 accent-blue-500"
                      />
                      <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                        {row.label}
                      </h2>
                      <span className="text-xs text-neutral-400 dark:text-neutral-600">
                        {row.count}
                      </span>
                    </div>
                  ) : (
                    <ItemRow
                      item={row.item}
                      checked={selected.has(row.item.id)}
                      onToggle={onToggleItem}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </main>
      </div>

      {confirmOpen && (
        <ConfirmModal
          items={selectedItems}
          helperState={helperState}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => {
            setConfirmOpen(false)
            onConfirmDelete()
          }}
        />
      )}
    </div>
  )
}
