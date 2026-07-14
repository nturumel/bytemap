import { useEffect, useMemo, useRef, useState } from 'react'
import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy'
import type { DiskNode } from '@shared/types'
import { formatBytes } from '@shared/format'
import {
  classifyPath,
  isActionableTarget,
  tierPriority,
  type CleanupTarget
} from '@shared/cleanupTargets'

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

function categoryColor(node: DisplayNode, sizeShare: number): string {
  if (node.isOther) return 'var(--viz-cache)'
  if (!node.isDir) return 'var(--viz-file)'
  if (OPAQUE_SUFFIXES.some((s) => node.name.endsWith(s))) return 'var(--viz-bundle)'
  if (CACHE_LIKE_NAMES.has(node.name) || node.target?.primaryAction === 'clearCache') {
    return 'var(--viz-cache)'
  }
  // Untagged folders: slight brightness lift for larger tiles so the map isn't flat.
  if (sizeShare >= 0.35) return 'color-mix(in srgb, var(--viz-dir) 88%, white)'
  if (sizeShare >= 0.15) return 'var(--viz-dir)'
  return 'color-mix(in srgb, var(--viz-dir) 82%, black)'
}

function tierOutline(tier: CleanupTarget['tier'] | undefined): string | undefined {
  if (!tier) return undefined
  switch (tier) {
    case 'safe':
      return 'var(--viz-target-safe)'
    case 'caution':
      return 'var(--viz-target-caution)'
    case 'inspect':
      return 'var(--viz-target-inspect)'
    case 'protected':
      return 'var(--viz-target-protected)'
  }
}

interface DisplayNode extends Omit<DiskNode, 'children'> {
  isOther?: boolean
  children?: DisplayNode[]
  target?: CleanupTarget | null
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
          ...top.map((n) => ({ ...n, target: classifyPath(n.path, n.name) })),
          {
            name: `${rest.length} more items`,
            path: '',
            size: restSize,
            isDir: false,
            isOther: true
          }
        ]
      : top.map((n) => ({ ...n, target: classifyPath(n.path, n.name) }))

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
  selectedPath,
  highlightPath,
  onSelect,
  onActivate
}: {
  nodes: DiskNode[]
  selectedPath: string | null
  highlightPath: string | null
  onSelect: (node: DiskNode) => void
  onActivate: (node: DiskNode) => void
}): React.JSX.Element {
  const [containerRef, { width, height }] = useElementSize()
  const rects = useMemo(() => layoutRects(nodes, width, height), [nodes, width, height])
  const viewTotal = useMemo(() => nodes.reduce((sum, n) => sum + n.size, 0), [nodes])

  return (
    <div ref={containerRef} className="relative h-full w-full">
      {rects.map((r) => {
        const selected = !r.node.isOther && r.node.path === selectedPath
        const highlighted = !r.node.isOther && r.node.path === highlightPath
        const outline = tierOutline(r.node.target?.tier)
        const sizeShare = viewTotal > 0 ? r.node.size / viewTotal : 0
        const showBadge =
          r.node.target &&
          (isActionableTarget(r.node.target) || r.node.target.tier === 'inspect') &&
          r.w > 56 &&
          r.h > 28

        return (
          <div
            key={r.node.path || r.node.name}
            onClick={(e) => {
              if (r.node.isOther) return
              e.stopPropagation()
              onSelect(r.node)
            }}
            onDoubleClick={() => {
              if (!r.node.isOther && r.node.isDir) onActivate(r.node)
            }}
            title={
              r.node.isOther
                ? r.node.name
                : `${r.node.path} — ${formatBytes(r.node.size)}${
                    r.node.target ? `\n${r.node.target.label}: ${r.node.target.reason}` : ''
                  }`
            }
            className={`viz-tile absolute overflow-hidden ${
              r.node.isOther ? '' : 'cursor-pointer'
            } ${selected ? 'viz-tile--selected' : ''} ${highlighted ? 'viz-tile--pulse' : ''}`}
            style={{
              left: r.x,
              top: r.y,
              width: r.w,
              height: r.h,
              backgroundColor: categoryColor(r.node, sizeShare),
              boxShadow: outline
                ? `inset 0 0 0 ${selected || highlighted ? 2.5 : 1.5}px ${outline}`
                : selected
                  ? `inset 0 0 0 2px color-mix(in srgb, #fff 55%, transparent)`
                  : undefined
            }}
          >
            {r.w > 46 && r.h > 22 && (
              <div className="p-1.5 leading-tight text-white">
                <div className="truncate font-mono text-[10px] font-medium tracking-tight">
                  {r.node.name}
                </div>
                {r.h > 34 && (
                  <div className="font-mono text-[10px] tabular-nums opacity-80">
                    {formatBytes(r.node.size)}
                  </div>
                )}
                {showBadge && r.node.target && (
                  <div
                    className="viz-badge mt-1 max-w-full truncate"
                    data-tier={r.node.target.tier}
                  >
                    {r.node.target.label}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** Paths of actionable reclaim targets in the current view, ordered for `N` cycling. */
export function suggestedTargetPaths(nodes: DiskNode[]): string[] {
  return nodes
    .map((n) => ({ node: n, target: classifyPath(n.path, n.name) }))
    .filter((x): x is { node: DiskNode; target: CleanupTarget } => {
      return !!x.target && (isActionableTarget(x.target) || x.target.tier === 'inspect')
    })
    .sort((a, b) => {
      const tp = tierPriority(a.target.tier) - tierPriority(b.target.tier)
      if (tp !== 0) return tp
      return b.node.size - a.node.size
    })
    .map((x) => x.node.path)
}
