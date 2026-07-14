import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import { join } from 'path'
import { dirSize, dirSizes } from '../native'

export { formatBytes } from '@shared/format'

const execFileAsync = promisify(execFile)

export const EXCLUDED_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'Library',
  '.Trash',
  '.npm',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  'env',
  '.tox',
  'site-packages',
  'dist',
  'build',
  '.next',
  '.pytest_cache',
  '.mypy_cache',
  'target',
  'DerivedData',
  // Docker Desktop's live VM disk — reclaimed via `docker system df`/prune (see
  // scanners/docker.ts), never by trashing files out from under a running daemon.
  'com.docker.docker',
  // System-level dirs that show up once we start walking /Library, /usr/local, etc. —
  // regenerable, root-owned, or sensitive enough that we shouldn't be recommending deletes.
  'Caches',
  'Extensions',
  'Frameworks',
  'PreferencePanes',
  // Xcode/CLT ships multiple full versioned SDK copies here (MacOSX14.5.sdk,
  // MacOSX15.2.sdk, ...) — cross-version "duplicates" are intentional and toolchain-
  // managed, same reasoning as node_modules/go's module cache.
  'CommandLineTools'
])

// App-managed library bundles (Photos, iMovie, GarageBand, disk images, .app bundles found
// outside /Applications, ...). These look like single items in Finder but are actually
// directories of internal files that app maintains a database/index over — deleting one
// from inside via Trash can corrupt the library in a way a normal file delete wouldn't.
// Report the bundle as one opaque item (see largeFiles.ts) instead of walking into it.
export const OPAQUE_BUNDLE_SUFFIXES = [
  '.photoslibrary',
  '.sparsebundle',
  '.imovielibrary',
  '.tvlibrary',
  '.fcpbundle',
  '.band',
  '.app'
]

export function isOpaqueBundle(name: string): boolean {
  return OPAQUE_BUNDLE_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

/** Size in bytes of a file or directory — native recursive sum, no subprocess spawn. */
export async function duSizeBytes(path: string): Promise<number> {
  try {
    return await dirSize(path)
  } catch {
    return 0
  }
}

/** Batched version of duSizeBytes — one native call, parallelized across cores internally. */
export async function duSizeBytesBatch(paths: string[]): Promise<number[]> {
  try {
    return await dirSizes(paths)
  } catch {
    return paths.map(() => 0)
  }
}

/** Spotlight "last used" date for a path, if macOS has tracked it. */
export async function lastUsedDate(path: string): Promise<Date | null> {
  return mdlsDate(path, 'kMDItemLastUsedDate')
}

/** When an app bundle's contents last changed (install or self-update) — a weak proxy for "last touched". */
export async function contentModifiedDate(path: string): Promise<Date | null> {
  return mdlsDate(path, 'kMDItemContentModificationDate')
}

async function mdlsDate(path: string, attribute: string): Promise<Date | null> {
  try {
    const { stdout } = await execFileAsync('mdls', ['-name', attribute, '-raw', path])
    const trimmed = stdout.trim()
    if (!trimmed || trimmed === '(null)') return null
    const date = new Date(trimmed)
    return Number.isNaN(date.getTime()) ? null : date
  } catch {
    return null
  }
}

/**
 * Whether any live process is running out of this app bundle. Catches menu-bar/login-item
 * apps (sync clients, window managers, VPNs) that stay resident without ever registering a
 * Spotlight "last opened" event — kMDItemLastUsedDate alone would misflag these as unused.
 */
export async function isAppRunning(appPath: string): Promise<boolean> {
  try {
    await execFileAsync('pgrep', ['-f', appPath])
    return true
  } catch {
    return false // pgrep exits non-zero when nothing matches
  }
}

/**
 * Locally-attached, non-boot volumes under /Volumes — external drives, not network shares
 * or cloud mounts (explicitly out of scope; those are excluded by filesystem type below).
 */
export async function discoverLocalVolumes(): Promise<string[]> {
  const NETWORK_FS_TYPES = new Set(['smbfs', 'afpfs', 'nfs', 'webdav', 'cifs', 'ftp'])
  let bootDeviceId: number
  try {
    bootDeviceId = (await fs.stat('/')).dev
  } catch {
    return []
  }

  let entries: string[]
  try {
    entries = await fs.readdir('/Volumes')
  } catch {
    return []
  }

  let mountOutput = ''
  try {
    mountOutput = (await execFileAsync('mount', [])).stdout
  } catch {
    return []
  }

  const results: string[] = []
  for (const name of entries) {
    const full = join('/Volumes', name)
    const stat = await fs.stat(full).catch(() => null)
    if (!stat || stat.dev === bootDeviceId) continue // alias back to the boot volume

    const mountLine = mountOutput.split('\n').find((line) => line.includes(` on ${full} `))
    const fsType = mountLine?.match(/\(([^,)]+)/)?.[1]
    if (fsType && NETWORK_FS_TYPES.has(fsType)) continue

    results.push(full)
  }
  return results
}

/** Runs `fn` over `items` with at most `limit` in flight at once. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const i = cursor++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

export function daysAgo(date: Date): number {
  return Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24))
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Recursively walk a directory yielding file paths, skipping excluded dir names,
 * symlinks, and stopping after `maxEntries` to bound worst-case scan time.
 */
export async function* walkFiles(
  root: string,
  opts: { maxEntries?: number; maxDepth?: number } = {}
): AsyncGenerator<{ path: string; stat: import('fs').Stats }> {
  const maxEntries = opts.maxEntries ?? 200_000
  const maxDepth = opts.maxDepth ?? 12
  let count = 0

  async function* recurse(
    dir: string,
    depth: number
  ): AsyncGenerator<{ path: string; stat: import('fs').Stats }> {
    if (depth > maxDepth || count >= maxEntries) return
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    const filePaths: string[] = []
    const dirPaths: string[] = []
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory() && isOpaqueBundle(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) dirPaths.push(full)
      else if (entry.isFile()) filePaths.push(full)
    }

    // Stat files in this directory concurrently — the syscall latency, not CPU, dominates.
    const budget = Math.max(0, maxEntries - count)
    const toStat = filePaths.slice(0, budget)
    const stats = await mapLimit(toStat, 32, (p) => fs.stat(p).catch(() => null))
    for (let i = 0; i < toStat.length; i++) {
      const stat = stats[i]
      if (!stat) continue
      count++
      yield { path: toStat[i], stat }
    }

    for (const d of dirPaths) {
      if (count >= maxEntries) return
      yield* recurse(d, depth + 1)
    }
  }

  yield* recurse(root, 0)
}
