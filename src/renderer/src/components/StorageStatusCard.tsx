import { useEffect, useState } from 'react'
import { formatBytes } from '@shared/format'
import type { VolumeStats } from '@shared/types'
import { VolumeCapacityMeter } from './VolumeCapacityMeter'

export function StorageStatusCard({
  stats
}: {
  stats: VolumeStats | null
}): React.JSX.Element | null {
  const [entered, setEntered] = useState(false)

  useEffect(() => {
    if (!stats) return
    setEntered(false)
    const id = window.setTimeout(() => setEntered(true), 60)
    return () => window.clearTimeout(id)
  }, [stats])

  if (!stats) return null

  const usedPct = Math.round(stats.usedRatio * 100)
  const freePct = Math.max(0, 100 - usedPct)
  const volumeLabel = stats.volumeName ?? 'This Mac'
  const mountHint =
    stats.mountPoint && stats.mountPoint !== '/'
      ? stats.mountPoint
      : stats.fileSystem
        ? stats.fileSystem
        : null

  const rows: { label: string; value: string; hint?: string }[] = [
    { label: 'Used', value: formatBytes(stats.usedBytes), hint: `${usedPct}%` },
    { label: 'Free', value: formatBytes(stats.freeBytes), hint: `${freePct}%` },
    { label: 'Capacity', value: formatBytes(stats.totalBytes) },
    {
      label: 'Volume',
      value: volumeLabel,
      hint: mountHint ?? undefined
    }
  ]

  if (stats.otherVolumeCount > 0) {
    rows.push({
      label: 'Other',
      value:
        stats.otherVolumeCount === 1
          ? '1 volume'
          : `${stats.otherVolumeCount} volumes`,
      hint: `${formatBytes(stats.otherVolumesFreeBytes)} free`
    })
  }

  return (
    <div
      className={`intro-storage no-drag ${entered ? 'intro-storage--in' : ''}`}
      role="region"
      aria-label="Storage status"
    >
      <div className="intro-storage__hero">
        <VolumeCapacityMeter
          stats={stats}
          compact
          showCopy={false}
          className="viz-capacity--intro"
        />
        <div className="intro-storage__hero-copy">
          <span className="intro-storage__eyebrow">This Mac</span>
          <span className="intro-storage__title">{volumeLabel}</span>
          <span className="intro-storage__subtitle font-mono tabular-nums">
            {formatBytes(stats.freeBytes)} free of {formatBytes(stats.totalBytes)}
          </span>
        </div>
      </div>

      <div
        className="intro-storage__bar"
        aria-hidden="true"
        style={{ ['--used-pct' as string]: `${Math.min(100, Math.max(0, usedPct))}%` }}
      >
        <span className="intro-storage__bar-fill" />
        <div className="intro-storage__legend">
          <span>
            <i className="intro-storage__swatch intro-storage__swatch--used" />
            Used
          </span>
          <span>
            <i className="intro-storage__swatch intro-storage__swatch--free" />
            Free
          </span>
        </div>
      </div>

      <dl className="intro-storage__facts">
        {rows.map((row) => (
          <div key={row.label} className="intro-storage__row">
            <dt className="intro-storage__label">{row.label}</dt>
            <dd className="intro-storage__value font-mono tabular-nums">
              <span>{row.value}</span>
              {row.hint ? <span className="intro-storage__hint">{row.hint}</span> : null}
            </dd>
          </div>
        ))}
      </dl>

      <p className="intro-storage__note">
        Capacity is this Mac&apos;s volume. The disk map starts in{' '}
        <span className="font-mono">{stats.mapRootLabel}</span> — not the whole drive.
      </p>
    </div>
  )
}
