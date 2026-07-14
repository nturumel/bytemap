import { homedir } from 'os'
import { promises as fs } from 'fs'
import { basename, extname, join } from 'path'
import type { ScanItem } from '@shared/types'
import {
  formatBytes,
  duSizeBytesBatch,
  pathExists,
  isOpaqueBundle,
  discoverLocalVolumes
} from './utils'
import { findLargeFiles } from '../native'

const THRESHOLD = 500 * 1024 * 1024

// Individual photos live at a much smaller scale than "large file" generally means — even
// a 50MP RAW is ~80-120MB, nowhere near 500MB — so the blanket threshold above would never
// catch them. Same category, same scan, just a size bar that actually matches the medium.
const IMAGE_THRESHOLD = 50 * 1024 * 1024
const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.heic',
  '.heif',
  '.tiff',
  '.tif',
  '.raw',
  '.cr2',
  '.cr3',
  '.nef',
  '.arw',
  '.dng',
  '.psd',
  '.gif',
  '.bmp',
  '.webp'
])

// Whole-disk coverage, not just $HOME: system-wide app data, common dev-tool install
// prefixes. Deliberately not /System or /private — SIP-protected and not user-actionable.
// External volumes are discovered separately (discoverLocalVolumes excludes network/cloud
// mounts — this tool never touches those).
const EXTRA_ROOTS = ['/Library', '/usr/local', '/opt/homebrew', '/opt/local']

// Shallow spots opaque bundles (Photos libraries, iMovie libraries, ...) typically live —
// deep enough to find them without doing a full recursive walk just for this.
const BUNDLE_SEARCH_DIRS = ['Pictures', 'Movies', 'Music', 'Documents', 'Desktop'].map((d) =>
  join(homedir(), d)
)

/** The native walk refuses to look inside these (see isOpaqueBundle); report each as one item instead. */
async function scanOpaqueBundles(
  emit: (item: ScanItem) => void,
  progress: (msg: string) => void
): Promise<void> {
  progress('Looking for app-managed libraries')
  const dirsToCheck = [homedir(), ...BUNDLE_SEARCH_DIRS]

  const found: { dir: string; name: string }[] = []
  for (const dir of dirsToCheck) {
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.isDirectory() && isOpaqueBundle(e.name)) found.push({ dir, name: e.name })
    }
  }

  const sizes = await duSizeBytesBatch(found.map(({ dir, name }) => join(dir, name)))
  found.forEach(({ dir, name }, i) => {
    const size = sizes[i]
    if (size < THRESHOLD) return
    emit({
      id: `largeFiles:${join(dir, name)}`,
      path: join(dir, name),
      name,
      sizeBytes: size,
      reason: 'App-managed library — delete as a whole via Finder, not from inside',
      category: 'largeFiles'
    })
  })
}

// iOS device backups live under Library (excluded from the general walk below, since
// Library also holds app-managed data stores like Photos/Mail that shouldn't be
// touched file-by-file) but are themselves just inert, safe-to-delete folders.
const BACKUP_ROOT = join(homedir(), 'Library', 'Application Support', 'MobileSync', 'Backup')

async function scanMobileBackups(
  emit: (item: ScanItem) => void,
  progress: (msg: string) => void
): Promise<void> {
  if (!(await pathExists(BACKUP_ROOT))) return
  progress('Measuring device backups')
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(BACKUP_ROOT, { withFileTypes: true })
  } catch {
    return
  }

  const backups = entries.filter((e) => e.isDirectory())
  const sizes = await duSizeBytesBatch(backups.map((e) => join(BACKUP_ROOT, e.name)))
  backups.forEach((entry, i) => {
    const size = sizes[i]
    if (size < THRESHOLD) return
    const full = join(BACKUP_ROOT, entry.name)
    emit({
      id: `largeFiles:${full}`,
      path: full,
      name: `iOS backup (${entry.name.slice(0, 8)}…)`,
      sizeBytes: size,
      reason: 'Device backup — safe to delete once you no longer need it',
      category: 'largeFiles'
    })
  })
}

export async function scanLargeFiles(
  emit: (item: ScanItem) => void,
  progress: (msg: string) => void
): Promise<void> {
  const localVolumes = await discoverLocalVolumes()
  const allRoots = [homedir(), ...EXTRA_ROOTS, ...localVolumes]
  const existingRoots: string[] = []
  for (const root of allRoots) {
    if (await pathExists(root)) existingRoots.push(root)
  }

  // Scan down to the lower (image) bound, then apply the right threshold per file below —
  // still one scan, one category, just size-aware about what "large" means for the type.
  const [files] = await Promise.all([
    findLargeFiles(existingRoots, IMAGE_THRESHOLD, progress),
    scanMobileBackups(emit, progress),
    scanOpaqueBundles(emit, progress)
  ])

  for (const f of files) {
    const isImage = IMAGE_EXTENSIONS.has(extname(f.path).toLowerCase())
    if (f.size < (isImage ? IMAGE_THRESHOLD : THRESHOLD)) continue
    emit({
      id: `largeFiles:${f.path}`,
      path: f.path,
      name: basename(f.path),
      sizeBytes: f.size,
      reason: isSealedSimulatorRuntime(f.path)
        ? `${formatBytes(f.size)} Xcode Simulator runtime — protected by macOS, remove via Xcode > Settings > Platforms`
        : `${formatBytes(f.size)} ${isImage ? 'image' : 'file'}`,
      category: 'largeFiles'
    })
  }
}

// These .dmg runtime images are SIP-sealed — not even root can move/delete them directly.
// Only Xcode's own tooling (Platforms settings, `xcrun simctl runtime delete`) can, since
// it carries the entitlement SIP checks for. Flagging this up front avoids promising a
// deletion this app (or any app) can't actually perform.
function isSealedSimulatorRuntime(path: string): boolean {
  return path.includes('/CoreSimulator/Images/') && extname(path).toLowerCase() === '.dmg'
}
