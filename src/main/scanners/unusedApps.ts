import { homedir } from 'os'
import { promises as fs } from 'fs'
import { join, basename } from 'path'
import type { ScanItem } from '@shared/types'
import {
  duSizeBytes,
  lastUsedDate,
  contentModifiedDate,
  daysAgo,
  pathExists,
  mapLimit,
  isAppRunning
} from './utils'
import { bundleIdentifier, lastUsedFromUsageDB } from './usageDb'

const APP_DIRS = ['/Applications', join(homedir(), 'Applications')]
const STALE_DAYS = 90
// Looser bar for the low-confidence fallback (no usage date at all, just "hasn't changed in
// a long time") — actively maintained apps that are actually in use tend to auto-update on a
// much shorter cadence than this, so a long gap is itself decent evidence.
const STALE_DAYS_NO_USAGE_DATA = 120

// Apps that are frequently "unused" by Spotlight's tracking but risky/annoying to flag.
const SKIP_NAMES = new Set(['App Store.app', 'System Settings.app', 'Preview.app', 'Safari.app'])

export async function scanUnusedApps(
  emit: (item: ScanItem) => void,
  progress: (msg: string) => void
): Promise<void> {
  for (const dir of APP_DIRS) {
    if (!(await pathExists(dir))) continue
    let entries: string[]
    try {
      entries = (await fs.readdir(dir)).filter((n) => n.endsWith('.app'))
    } catch {
      continue
    }

    const candidates = entries.filter((name) => !SKIP_NAMES.has(name))

    await mapLimit(candidates, 8, async (name) => {
      const full = join(dir, name)
      progress(`Checking ${name}`)

      // Tier 1 (high confidence): a real "last opened" timestamp, either from Spotlight
      // or macOS's usage-tracking database (requires Full Disk Access).
      const used = await lastUsedDate(full)
      const usageDbDate = used ? null : await tryUsageDb(full)
      const confirmedUsed = used ?? usageDbDate
      if (confirmedUsed) {
        if (daysAgo(confirmedUsed) < STALE_DAYS) return
        return emitUnused(emit, full, `Not opened in ${daysAgo(confirmedUsed)} days`)
      }

      // No usage date from either source. Menu-bar/login-item apps (sync clients, window
      // managers) stay resident without ever registering an "open" event — if it's running
      // right now, it's in use, full stop, regardless of what Spotlight thinks.
      if (await isAppRunning(full)) return

      // Tier 2 (low confidence): fall back to "hasn't changed in a long time" as weak
      // evidence of neglect. Labeled differently so it reads as a hint to double-check,
      // not a confident claim.
      const modified = await contentModifiedDate(full)
      if (!modified || daysAgo(modified) < STALE_DAYS_NO_USAGE_DATA) return
      await emitUnused(
        emit,
        full,
        `No usage data — hasn't been updated since ${modified.toISOString().slice(0, 10)}`
      )
    })
  }
}

async function tryUsageDb(appPath: string): Promise<Date | null> {
  const bundleId = await bundleIdentifier(appPath)
  return bundleId ? lastUsedFromUsageDB(bundleId) : null
}

async function emitUnused(
  emit: (item: ScanItem) => void,
  full: string,
  reason: string
): Promise<void> {
  const size = await duSizeBytes(full)
  if (size === 0) return
  emit({
    id: `unusedApps:${full}`,
    path: full,
    name: basename(full, '.app'),
    sizeBytes: size,
    reason,
    category: 'unusedApps'
  })
}
