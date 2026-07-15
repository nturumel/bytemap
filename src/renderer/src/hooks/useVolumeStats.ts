import { useCallback, useEffect, useState } from 'react'
import type { VolumeStats } from '@shared/types'

const POLL_MS = 60_000

export function useVolumeStats(probePath = '/'): {
  stats: VolumeStats | null
  loading: boolean
  error: string | null
  refresh: () => void
} {
  const [stats, setStats] = useState<VolumeStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    void window.api.disk
      .getVolumeStats(probePath)
      .then((next) => {
        setStats(next)
        setError(null)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not read disk capacity')
      })
      .finally(() => setLoading(false))
  }, [probePath])

  useEffect(() => {
    refresh()
    const id = window.setInterval(refresh, POLL_MS)
    const onFocus = (): void => refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(id)
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])

  return { stats, loading, error, refresh }
}
