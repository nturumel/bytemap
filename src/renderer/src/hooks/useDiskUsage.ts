import { useCallback, useEffect, useRef, useState } from 'react'
import type { DiskChangeEvent, DiskNode } from '@shared/types'

interface Breadcrumb {
  name: string
  path: string | null
}

interface CacheEntry {
  children: DiskNode[]
  /** True when FS watcher invalidated this entry and a refresh is pending/in-flight. */
  stale: boolean
  updatedAt: number
}

export interface UseDiskUsageState {
  breadcrumbs: Breadcrumb[]
  children: DiskNode[]
  loading: boolean
  /** Stale-while-revalidate: showing cached tiles while a refresh runs. */
  refreshing: boolean
  selectedPath: string | null
  setSelectedPath: (path: string | null) => void
  drillInto: (node: DiskNode) => void
  goToBreadcrumb: (index: number) => void
  refresh: () => void
  /** Drop a path from the current view after a successful delete (optimistic). */
  removeChild: (path: string) => void
  /** Absolute path currently visualized (home resolved on main; null means home sentinel). */
  currentPath: string | null
}

const HOME_KEY = '__home__'
/** Coalesce rapid watcher invalidations into one visible reload. */
const RENDERER_REVALIDATE_DEBOUNCE_MS = 800

function cacheKey(path: string | null): string {
  return path ?? HOME_KEY
}

/**
 * Disk map loader with:
 * - Generational load IDs (stale streams ignored — same class as breadcrumb fix)
 * - Cache with stale-while-revalidate on watcher invalidation
 * - Watcher subscription that invalidates affected keys and revalidates visible path
 * - Debounced revalidate so main-process coalesced events cannot stack force-loads
 */
export function useDiskUsage(): UseDiskUsageState {
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([{ name: 'This Mac', path: null }])
  const [children, setChildren] = useState<DiskNode[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)

  const cacheRef = useRef<Map<string, CacheEntry>>(new Map())
  const childrenRef = useRef<DiskNode[]>([])
  const breadcrumbsRef = useRef(breadcrumbs)
  const loadIdRef = useRef(0)
  const acceptingChildrenRef = useRef(false)
  /** Path currently being loaded (for watcher / breakdown coordination). */
  const loadingPathRef = useRef<string | null | undefined>(undefined)
  /** Last watcher generation applied per root — drop older payloads. */
  const lastWatchGenRef = useRef<Map<string, number>>(new Map())
  const revalidateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRevalidateRef = useRef<{ path: string | null; selfTriggered: boolean } | null>(
    null
  )

  breadcrumbsRef.current = breadcrumbs

  useEffect(() => {
    return window.api.disk.onChild((node) => {
      if (!acceptingChildrenRef.current) return
      childrenRef.current = [...childrenRef.current, node].sort((a, b) => b.size - a.size)
      setChildren(childrenRef.current)
    })
  }, [])

  const load = useCallback((path: string | null, opts?: { force?: boolean; swr?: boolean }) => {
    const loadId = ++loadIdRef.current
    const key = cacheKey(path)
    const cached = cacheRef.current.get(key)
    const force = opts?.force === true
    const swr = opts?.swr === true

    if (cached && !force && !cached.stale) {
      acceptingChildrenRef.current = false
      childrenRef.current = cached.children
      setChildren(cached.children)
      setLoading(false)
      setRefreshing(false)
      loadingPathRef.current = undefined
      void window.api.disk.cancelBreakdown()
      void window.api.disk.watch(path)
      return
    }

    // Stale-while-revalidate: keep painting last known tiles (including forced
    // watcher refreshes when `swr` is set — never blank the map for incremental updates).
    if (cached && cached.children.length > 0 && (swr || (cached.stale && !force))) {
      childrenRef.current = cached.children
      setChildren(cached.children)
      setLoading(false)
      setRefreshing(true)
    } else if (!cached || force) {
      childrenRef.current = []
      setChildren([])
      setLoading(true)
      setRefreshing(false)
    } else {
      // stale empty cache
      childrenRef.current = []
      setChildren([])
      setLoading(true)
      setRefreshing(false)
    }

    acceptingChildrenRef.current = true
    loadingPathRef.current = path
    void window.api.disk.watch(path)
    window.api.disk.breakdown(path).then(() => {
      if (loadId !== loadIdRef.current) return
      acceptingChildrenRef.current = false
      loadingPathRef.current = undefined
      setLoading(false)
      setRefreshing(false)
      cacheRef.current.set(key, {
        children: childrenRef.current,
        stale: false,
        updatedAt: Date.now()
      })
    })
  }, [])

  const scheduleRevalidate = useCallback(
    (path: string | null, selfTriggered: boolean) => {
      pendingRevalidateRef.current = { path, selfTriggered }
      if (revalidateTimerRef.current) clearTimeout(revalidateTimerRef.current)
      const delay = selfTriggered ? 150 : RENDERER_REVALIDATE_DEBOUNCE_MS
      revalidateTimerRef.current = setTimeout(() => {
        revalidateTimerRef.current = null
        const pending = pendingRevalidateRef.current
        pendingRevalidateRef.current = null
        if (!pending) return
        const current = breadcrumbsRef.current[breadcrumbsRef.current.length - 1]
        // Breadcrumb moved away — skip; the new view has its own load.
        if (cacheKey(current.path) !== cacheKey(pending.path)) return
        // Already measuring this path — let it finish; main coalesce will re-fire if needed.
        if (loadingPathRef.current === pending.path) return
        const key = cacheKey(pending.path)
        cacheRef.current.delete(key)
        load(pending.path, { swr: true, force: true })
      }, delay)
    },
    [load]
  )

  useEffect(() => {
    load(null)
    return () => {
      if (revalidateTimerRef.current) clearTimeout(revalidateTimerRef.current)
      void window.api.disk.unwatch()
      void window.api.disk.cancelBreakdown()
    }
  }, [load])

  // Incremental invalidation from main-process watcher.
  useEffect(() => {
    return window.api.disk.onChanged((event: DiskChangeEvent) => {
      const prevGen = lastWatchGenRef.current.get(event.root) ?? 0
      if (event.generation < prevGen) return
      lastWatchGenRef.current.set(event.root, event.generation)

      // Mark any cached folder under this root as stale.
      for (const [key, entry] of cacheRef.current) {
        if (key === HOME_KEY) continue
        if (key === event.root || key.startsWith(event.root + '/')) {
          cacheRef.current.set(key, { ...entry, stale: true })
        }
      }
      // Home sentinel may wrap the watched root.
      const homeEntry = cacheRef.current.get(HOME_KEY)
      if (homeEntry) cacheRef.current.set(HOME_KEY, { ...homeEntry, stale: true })

      const current = breadcrumbsRef.current[breadcrumbsRef.current.length - 1]
      const currentKey = cacheKey(current.path)

      // If this view is mid empty first-load, don't interrupt — breakdownActive on main
      // already coalesces; when it finishes SWR will pick up via stale flag on next event.
      if (loadingPathRef.current === current.path && childrenRef.current.length === 0) {
        return
      }

      // Revalidate visible map when the change touches it (or self-delete refresh).
      // Home (`path === null`) only reacts to events whose root is the home watch itself
      // (main maps null → home). Aux-root events for paths outside the home recursive
      // watch should not force a full remasure — and under-home aux roots are no longer
      // double-watched; quiet prefixes further suppress Caches/Logs/app noise.
      const touchesCurrent =
        event.selfTriggered ||
        (current.path === null
          ? event.childNames.length > 0 || event.paths.length > 0
          : event.root === current.path ||
            event.root.startsWith(current.path + '/') ||
            current.path.startsWith(event.root + '/') ||
            event.paths.some(
              (p) => p === current.path || p.startsWith((current.path ?? '') + '/')
            ))

      if (!touchesCurrent) return

      // Drop selection if the selected node disappeared.
      setSelectedPath((sel) => {
        if (!sel) return sel
        if (event.paths.some((p) => p === sel || sel.startsWith(p + '/'))) return null
        return sel
      })

      // Mark stale immediately; debounce the actual force-load.
      const entry = cacheRef.current.get(currentKey)
      if (entry) cacheRef.current.set(currentKey, { ...entry, stale: true })
      scheduleRevalidate(current.path, event.selfTriggered)
    })
  }, [scheduleRevalidate])

  const drillInto = useCallback(
    (node: DiskNode) => {
      if (!node.isDir) return
      setSelectedPath(null)
      setBreadcrumbs((prev) => [...prev, { name: node.name, path: node.path }])
      load(node.path)
    },
    [load]
  )

  const goToBreadcrumb = useCallback(
    (index: number) => {
      const prev = breadcrumbsRef.current
      if (index < 0 || index >= prev.length - 1) return
      const next = prev.slice(0, index + 1)
      setSelectedPath(null)
      setBreadcrumbs(next)
      load(next[next.length - 1].path)
    },
    [load]
  )

  const refresh = useCallback(() => {
    const current = breadcrumbsRef.current[breadcrumbsRef.current.length - 1]
    if (revalidateTimerRef.current) {
      clearTimeout(revalidateTimerRef.current)
      revalidateTimerRef.current = null
    }
    pendingRevalidateRef.current = null
    cacheRef.current.delete(cacheKey(current.path))
    load(current.path, { force: true })
  }, [load])

  const removeChild = useCallback((path: string) => {
    childrenRef.current = childrenRef.current.filter((n) => n.path !== path)
    setChildren(childrenRef.current)
    const current = breadcrumbsRef.current[breadcrumbsRef.current.length - 1]
    const key = cacheKey(current.path)
    const entry = cacheRef.current.get(key)
    if (entry) {
      cacheRef.current.set(key, {
        ...entry,
        children: childrenRef.current,
        stale: true
      })
    }
    if (selectedPath === path) setSelectedPath(null)
  }, [selectedPath])

  const currentPath = breadcrumbs[breadcrumbs.length - 1]?.path ?? null

  return {
    breadcrumbs,
    children,
    loading,
    refreshing,
    selectedPath,
    setSelectedPath,
    drillInto,
    goToBreadcrumb,
    refresh,
    removeChild,
    currentPath
  }
}
