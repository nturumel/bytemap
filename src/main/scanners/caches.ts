import { homedir } from 'os'
import { promises as fs } from 'fs'
import { join, basename } from 'path'
import type { ScanItem } from '@shared/types'
import { duSizeBytesBatch, pathExists, formatBytes } from './utils'
import { scanDocker } from './docker'

const THRESHOLD = 100 * 1024 * 1024

const WHOLE_DIR_CACHES = [
  { path: join(homedir(), 'Library', 'Logs'), label: 'System & app logs' },
  {
    path: join(homedir(), 'Library', 'Developer', 'Xcode', 'DerivedData'),
    label: 'Xcode build cache'
  },
  { path: join(homedir(), '.npm', '_cacache'), label: 'npm cache' },
  { path: join(homedir(), 'Library', 'pnpm', 'store'), label: 'pnpm store' },
  { path: join(homedir(), '.local', 'share', 'pnpm', 'store'), label: 'pnpm store' },
  { path: join(homedir(), '.cargo', 'registry'), label: 'Cargo registry cache' },
  { path: join(homedir(), '.gradle', 'caches'), label: 'Gradle cache' }
]

// Both of these are "one folder per tool" directories — breaking down by immediate
// subfolder (rather than reporting one lump sum) is what actually tells the user whether
// it's uv, huggingface, pip, or something else eating the space, and lets them clear just
// the one they don't need.
const BREAKDOWN_DIRS = [join(homedir(), 'Library', 'Caches'), join(homedir(), '.cache')]

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
  presentWholeDirCaches.forEach(({ path, label }, i) => {
    const size = wholeDirSizes[i]
    if (size < THRESHOLD) return
    emit({
      id: `caches:${path}`,
      path,
      name: label,
      sizeBytes: size,
      reason: `${formatBytes(size)} — regenerates automatically`,
      category: 'caches',
      action: { kind: 'remove' }
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
}
