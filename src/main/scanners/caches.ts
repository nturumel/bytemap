import { homedir } from 'os'
import { promises as fs } from 'fs'
import { join, basename } from 'path'
import type { ScanItem } from '@shared/types'
import { duSizeBytesBatch, pathExists, formatBytes } from './utils'
import { scanDocker } from './docker'
import { scanAppLeftovers } from './appLeftovers'

const THRESHOLD = 100 * 1024 * 1024
const CAUTION_THRESHOLD = 200 * 1024 * 1024

const WHOLE_DIR_CACHES: { path: string; label: string; action: 'remove' | 'trash'; min?: number }[] =
  [
    { path: join(homedir(), 'Library', 'Logs'), label: 'System & app logs', action: 'remove' },
    {
      path: join(homedir(), 'Library', 'Developer', 'Xcode', 'DerivedData'),
      label: 'Xcode build cache',
      action: 'remove'
    },
    {
      path: join(homedir(), 'Library', 'Developer', 'Xcode', 'DocumentationCache'),
      label: 'Xcode documentation cache',
      action: 'remove'
    },
    { path: join(homedir(), '.npm', '_cacache'), label: 'npm cache', action: 'remove' },
    { path: join(homedir(), 'Library', 'pnpm', 'store'), label: 'pnpm store', action: 'remove' },
    {
      path: join(homedir(), '.local', 'share', 'pnpm', 'store'),
      label: 'pnpm store',
      action: 'remove'
    },
    { path: join(homedir(), '.yarn', 'cache'), label: 'Yarn cache', action: 'remove' },
    { path: join(homedir(), '.cargo', 'registry'), label: 'Cargo registry cache', action: 'remove' },
    { path: join(homedir(), '.cargo', 'git'), label: 'Cargo git cache', action: 'remove' },
    { path: join(homedir(), '.gradle', 'caches'), label: 'Gradle cache', action: 'remove' },
    { path: join(homedir(), 'go', 'pkg', 'mod'), label: 'Go module cache', action: 'remove' },
    {
      path: join(homedir(), 'Library', 'Caches', 'Homebrew'),
      label: 'Homebrew cache',
      action: 'remove'
    },
    {
      path: join('/opt', 'homebrew', 'var', 'homebrew', 'tmp'),
      label: 'Homebrew temp',
      action: 'remove',
      min: 50 * 1024 * 1024
    },
    {
      path: join(homedir(), 'Library', 'Developer', 'Xcode', 'iOS DeviceSupport'),
      label: 'Xcode iOS device symbols',
      action: 'trash',
      min: CAUTION_THRESHOLD
    },
    {
      path: join(homedir(), 'Library', 'Developer', 'Xcode', 'Archives'),
      label: 'Xcode Archives',
      action: 'trash',
      min: CAUTION_THRESHOLD
    }
  ]

// Both of these are "one folder per tool" directories — breaking down by immediate
// subfolder (rather than reporting one lump sum) is what actually tells the user whether
// it's uv, huggingface, pip, or something else eating the space, and lets them clear just
// the one they don't need.
const BREAKDOWN_DIRS = [join(homedir(), 'Library', 'Caches'), join(homedir(), '.cache')]

/** Never recommend clearing these Library/Caches children wholesale. */
const CACHE_DENYLIST = new Set([
  'CloudKit',
  'com.apple.HomeKit',
  'com.apple.Safari',
  'FamilyCircle',
  'PassKit'
])

export async function scanCaches(
  emit: (item: ScanItem) => void,
  progress: (msg: string) => void
): Promise<void> {
  await scanDocker(emit, progress)

  progress('Measuring caches & logs')
  const wholeDirCaches = await Promise.all(
    WHOLE_DIR_CACHES.map(async (c) => ((await pathExists(c.path)) ? c : null))
  )
  const presentWholeDirCaches = wholeDirCaches.filter(
    (c): c is (typeof WHOLE_DIR_CACHES)[0] => c !== null
  )
  const wholeDirSizes = await duSizeBytesBatch(presentWholeDirCaches.map((c) => c.path))
  presentWholeDirCaches.forEach(({ path, label, action, min }, i) => {
    const size = wholeDirSizes[i]
    const floor = min ?? THRESHOLD
    if (size < floor) return
    emit({
      id: `caches:${path}`,
      path,
      name: label,
      sizeBytes: size,
      reason:
        action === 'trash'
          ? `${formatBytes(size)} — regenerable with rebuild/download cost`
          : `${formatBytes(size)} — regenerates automatically`,
      category: 'caches',
      action: { kind: action }
    })
  })

  for (const dir of BREAKDOWN_DIRS) {
    if (!(await pathExists(dir))) continue
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      entries = []
    }
    const fullPaths = entries.map((name) => join(dir, name))
    const sizes = await duSizeBytesBatch(fullPaths)
    entries.forEach((name, i) => {
      if (CACHE_DENYLIST.has(name)) return
      const size = sizes[i]
      if (size < THRESHOLD) return
      emit({
        id: `caches:${fullPaths[i]}`,
        path: fullPaths[i],
        name: `Cache: ${basename(name)}`,
        sizeBytes: size,
        reason: `${formatBytes(size)} — regenerates automatically`,
        category: 'caches',
        action: { kind: 'remove' }
      })
    })
  }

  await scanAppLeftovers(emit, progress)
}
