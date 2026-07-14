import { useCallback, useEffect, useRef, useState } from 'react'
import type { DiskNode } from '@shared/types'

interface Breadcrumb {
  name: string
  path: string | null
}

export interface UseDiskUsageState {
  breadcrumbs: Breadcrumb[]
  children: DiskNode[]
  loading: boolean
  drillInto: (node: DiskNode) => void
  goToBreadcrumb: (index: number) => void
  refresh: () => void
}

const HOME_KEY = '__home__'

export function useDiskUsage(): UseDiskUsageState {
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([{ name: 'This Mac', path: null }])
  const [children, setChildren] = useState<DiskNode[]>([])
  const [loading, setLoading] = useState(true)
  const cacheRef = useRef<Map<string, DiskNode[]>>(new Map())
  const childrenRef = useRef<DiskNode[]>([])
  const breadcrumbsRef = useRef(breadcrumbs)
  // Monotonic load id so stale streams / promise resolutions never mutate UI or cache.
  const loadIdRef = useRef(0)
  // Cache hits do not call breakdown(), so main never bumps latestBreakdownRequest —
  // ignore child events until the next uncached load starts.
  const acceptingChildrenRef = useRef(false)

  breadcrumbsRef.current = breadcrumbs

  useEffect(() => {
    return window.api.disk.onChild((node) => {
      if (!acceptingChildrenRef.current) return
      childrenRef.current = [...childrenRef.current, node].sort((a, b) => b.size - a.size)
      setChildren(childrenRef.current)
    })
  }, [])

  const load = useCallback((path: string | null) => {
    const loadId = ++loadIdRef.current
    const key = path ?? HOME_KEY
    const cached = cacheRef.current.get(key)
    if (cached) {
      acceptingChildrenRef.current = false
      childrenRef.current = cached
      setChildren(cached)
      setLoading(false)
      // Stop any in-flight scan — cache hits skip breakdown(), which would otherwise leave
      // latestBreakdownRequest pointing at the scan we just navigated away from.
      void window.api.disk.cancelBreakdown()
      return
    }
    acceptingChildrenRef.current = true
    childrenRef.current = []
    setChildren([])
    setLoading(true)
    window.api.disk.breakdown(path).then(() => {
      if (loadId !== loadIdRef.current) return
      acceptingChildrenRef.current = false
      setLoading(false)
      cacheRef.current.set(key, childrenRef.current)
    })
  }, [])

  useEffect(() => {
    load(null)
  }, [load])

  const drillInto = useCallback(
    (node: DiskNode) => {
      if (!node.isDir) return
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
      setBreadcrumbs(next)
      load(next[next.length - 1].path)
    },
    [load]
  )

  const refresh = useCallback(() => {
    const current = breadcrumbsRef.current[breadcrumbsRef.current.length - 1]
    cacheRef.current.delete(current.path ?? HOME_KEY)
    load(current.path)
  }, [load])

  return { breadcrumbs, children, loading, drillInto, goToBreadcrumb, refresh }
}
