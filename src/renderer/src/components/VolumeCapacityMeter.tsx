import { useEffect, useRef, useState } from 'react'
import { formatBytes } from '@shared/format'
import type { VolumeStats } from '@shared/types'

type FillLevel = 'ok' | 'warn' | 'critical'

function fillLevel(ratio: number): FillLevel {
  if (ratio >= 0.92) return 'critical'
  if (ratio >= 0.8) return 'warn'
  return 'ok'
}

function useCountUp(target: number, durationMs: number, enabled: boolean): number {
  const [value, setValue] = useState(0)
  const fromRef = useRef(0)

  useEffect(() => {
    if (!enabled) {
      setValue(target)
      fromRef.current = target
      return
    }
    const from = fromRef.current
    const start = performance.now()
    let raf = 0
    const tick = (now: number): void => {
      const t = Math.min(1, (now - start) / durationMs)
      const eased = 1 - Math.pow(1 - t, 3)
      setValue(from + (target - from) * eased)
      if (t < 1) raf = requestAnimationFrame(tick)
      else fromRef.current = target
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, durationMs, enabled])

  return value
}

export function VolumeCapacityMeter({
  stats,
  compact = false,
  showCopy = true,
  className = ''
}: {
  stats: VolumeStats | null
  compact?: boolean
  /** When false, only the donut is rendered (for richer storage cards). */
  showCopy?: boolean
  className?: string
}): React.JSX.Element | null {
  const [entered, setEntered] = useState(false)

  useEffect(() => {
    if (!stats) return
    setEntered(false)
    const id = window.setTimeout(() => setEntered(true), 40)
    return () => window.clearTimeout(id)
  }, [stats])

  const ratio = stats?.usedRatio ?? 0
  const level = fillLevel(ratio)
  const displayPct = useCountUp(ratio * 100, 780, Boolean(stats) && entered)
  const size = compact ? 36 : 44
  const stroke = compact ? 3.5 : 4
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const dash = entered ? c * Math.min(1, Math.max(0, ratio)) : 0

  if (!stats) return null

  const pctLabel = `${Math.round(displayPct)}%`
  const freeLabel = `${formatBytes(stats.freeBytes)} free`
  const usedLabel = `${formatBytes(stats.usedBytes)} of ${formatBytes(stats.totalBytes)}`
  const titleLabel = stats.volumeName ?? 'Disk'

  return (
    <div
      className={`viz-capacity no-drag ${compact ? 'viz-capacity--compact' : ''} ${className}`}
      data-level={level}
      title={`${titleLabel}: ${usedLabel} · ${freeLabel}`}
      role="img"
      aria-label={`${titleLabel} ${pctLabel} used — ${usedLabel}, ${freeLabel}`}
    >
      <svg
        className="viz-capacity__ring"
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden="true"
      >
        <circle
          className="viz-capacity__track"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
        />
        <circle
          className="viz-capacity__arc"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c - dash}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text
          x="50%"
          y="50%"
          dominantBaseline="central"
          textAnchor="middle"
          className="viz-capacity__pct"
          style={{ fontSize: compact ? 9 : 10 }}
        >
          {pctLabel}
        </text>
      </svg>
      {showCopy ? (
        <div className="viz-capacity__copy">
          <span className="viz-capacity__label">{titleLabel}</span>
          <span className="viz-capacity__used font-mono tabular-nums">{usedLabel}</span>
          <span className="viz-capacity__free font-mono tabular-nums">{freeLabel}</span>
        </div>
      ) : null}
    </div>
  )
}
