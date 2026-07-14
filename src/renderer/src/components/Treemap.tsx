import { useEffect, useMemo, useRef, useState } from 'react'
import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy'
import type { DiskNode } from '@shared/types'
import { formatBytes } from '@shared/format'

const MAX_RECTS = 60

const CACHE_LIKE_NAMES = new Set([
  'node_modules',
  '.git',
  '.cache',
  'Caches',
  'target',
  'build',
  'dist',
  '.next',
  '__pycache__',
  'venv',
  '.venv',
  'DerivedData',
  '.npm',
  '.Trash'
])

const OPAQUE_SUFFIXES = [
  '.app',
  '.photoslibrary',
  '.sparsebundle',
  '.imovielibrary',
  '.fcpbundle',
  '.band'
]

function categoryColor(node: DisplayNode): string {
  if (node.isOther) return 'var(--viz-cache)'
  if (!node.isDir) return 'var(--viz-file)'
  if (OPAQUE_SUFFIXES.some((s) => node.name.endsWith(s))) return 'var(--viz-bundle)'
  if (CACHE_LIKE_NAMES.has(node.name)) return 'var(--viz-cache)'
  return 'var(--viz-dir)'
}

interface DisplayNode extends Omit<DiskNode, 'children'> {
  isOther?: boolean
  children?: DisplayNode[]
}

interface Rect {
  node: DisplayNode
  x: number
  y: number
  w: number
  h: number
}

function useElementSize(): [
  React.RefObject<HTMLDivElement | null>,
  { width: number; height: number }
] {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return [ref, size]
}

function layoutRects(nodes: DiskNode[], width: number, height: number): Rect[] {
  if (nodes.length === 0 || width <= 0 || height <= 0) return []

  const top = nodes.slice(0, MAX_RECTS)
  const rest = nodes.slice(MAX_RECTS)
  const restSize = rest.reduce((sum, n) => sum + n.size, 0)

  const displayNodes: DisplayNode[] =
    restSize > 0
      ? [
          ...top,
          {
            name: `${rest.length} more items`,
            path: '',
            size: restSize,
            isDir: false,
            isOther: true
          }
        ]
      : top

  const rootData: DisplayNode = { name: '', path: '', size: 0, isDir: true, children: displayNodes }
  const root = hierarchy(rootData, (d) => d.children).sum((d) => (d.children ? 0 : d.size))

  const layout = treemap<DisplayNode>()
    .tile(treemapSquarify)
    .size([width, height])
    .paddingInner(2)
    .round(true)

  const laidOut = layout(root)

  return (laidOut.children ?? []).map((leaf) => ({
    node: leaf.data,
    x: leaf.x0,
    y: leaf.y0,
    w: leaf.x1 - leaf.x0,
    h: leaf.y1 - leaf.y0
  }))
}

export function Treemap({
  nodes,
  onSelect
}: {
  nodes: DiskNode[]
  onSelect: (node: DiskNode) => void
}): React.JSX.Element {
  const [containerRef, { width, height }] = useElementSize()
  const rects = useMemo(() => layoutRects(nodes, width, height), [nodes, width, height])

  return (
    <div ref={containerRef} className="relative h-full w-full">
      {rects.map((r) => (
        <div
          key={r.node.path || r.node.name}
          onClick={() => !r.node.isOther && r.node.isDir && onSelect(r.node)}
          title={`${r.node.path || r.node.name} — ${formatBytes(r.node.size)}`}
          className={`absolute overflow-hidden rounded-[3px] border border-black/10 transition hover:brightness-110 dark:border-white/10 ${
            r.node.isOther ? '' : r.node.isDir ? 'cursor-pointer' : 'cursor-default'
          }`}
          style={{
            left: r.x,
            top: r.y,
            width: r.w,
            height: r.h,
            backgroundColor: categoryColor(r.node)
          }}
        >
          {r.w > 46 && r.h > 22 && (
            <div className="p-1 leading-tight text-white">
              <div className="truncate text-[11px] font-medium">{r.node.name}</div>
              {r.h > 34 && <div className="text-[10px] opacity-80">{formatBytes(r.node.size)}</div>}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
