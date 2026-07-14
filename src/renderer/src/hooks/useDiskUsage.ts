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

  // One listener for the app's lifetime — main process already filters out nodes from
  // superseded requests, so every event received here belongs to the current `load()`.
  useEffect(() => {
    return window.api.disk.onChild((node) => {
      childrenRef.current = [...childrenRef.current, node].sort((a, b) => b.size - a.size)
      setChildren(childrenRef.current)
    })
  }, [])

  const load = useCallback((path: string | null) => {
    const key = path ?? HOME_KEY
    const cached = cacheRef.current.get(key)
    if (cached) {
      childrenRef.current = cached
      setChildren(cached)
      setLoading(false)
      return
    }
    childrenRef.current = []
    setChildren([])
    setLoading(true)
    window.api.disk.breakdown(path).then(() => {
      setLoading(false)
      cacheRef.current.set(key, childrenRef.current)
    })
  }, [])

  useEffect(() => {
    load(null)
    // Only ever runs once on mount — `load` itself is stable (useCallback with no deps).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
      setBreadcrumbs((prev) => {
        const next = prev.slice(0, index + 1)
        load(next[next.length - 1].path)
        return next
      })
    },
    [load]
  )

  const refresh = useCallback(() => {
    setBreadcrumbs((prev) => {
      const current = prev[prev.length - 1]
      cacheRef.current.delete(current.path ?? HOME_KEY)
      load(current.path)
      return prev
    })
  }, [load])

  return { breadcrumbs, children, loading, drillInto, goToBreadcrumb, refresh }
}
