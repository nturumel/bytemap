import { promises as fs } from 'fs'
import { homedir } from 'os'
import { join, basename } from 'path'
import type { ScanItem } from '@shared/types'
import { pathExists, mapLimit } from './utils'
import { findDuplicates } from '../scanner'

const MIN_SIZE = 4 * 1024 // ignore trivial files

// Skip Library/Applications (app-managed data, risky to fingerprint file-by-file — see
// largeFiles.ts), Public (rarely relevant), and go (Go's module cache — intentionally
// has near-duplicate files across package versions, same reasoning as node_modules).
// Everything else the user actually put there — Downloads, Documents, project folders,
// whatever — gets scanned.
const SKIP_TOP_LEVEL = new Set(['Library', 'Applications', 'Public', 'go'])

// System-wide roots, same reasoning as largeFiles.ts. External volumes are deliberately
// excluded here (unlike largeFiles) — hashing every file on a large external drive is a
// different cost trade-off than just statting them; large-file detection still covers them.
const SYSTEM_ROOTS = ['/Library', '/usr/local', '/opt/homebrew', '/opt/local']

/** Every top-level folder in $HOME the user might reasonably have duplicate content in. */
async function discoverScanRoots(): Promise<string[]> {
  const home = homedir()
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(home, { withFileTypes: true })
  } catch {
    return []
  }
  const homeRoots = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_TOP_LEVEL.has(e.name))
    .map((e) => join(home, e.name))

  const systemRoots = await mapLimit(SYSTEM_ROOTS, 4, async (root) =>
    (await pathExists(root)) ? root : null
  )

  return [...homeRoots, ...systemRoots.filter((r): r is string => r !== null)]
}

export async function scanDuplicates(
  emit: (item: ScanItem) => void,
  progress: (msg: string) => void,
  cacheDbPath: string
): Promise<void> {
  const scanRoots = await discoverScanRoots()
  const groups = await findDuplicates(scanRoots, MIN_SIZE, cacheDbPath, progress)

  for (const group of groups) {
    for (const path of group.duplicates) {
      emit({
        id: `duplicates:${path}`,
        path,
        name: basename(path),
        sizeBytes: group.size,
        reason: `Duplicate of ${basename(group.keeper)}`,
        category: 'duplicates',
        keptInsteadOf: group.keeper
      })
    }
  }
}
