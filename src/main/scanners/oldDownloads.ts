import { homedir } from 'os'
import { basename, join } from 'path'
import type { ScanItem } from '@shared/types'
import { walkFiles, pathExists, daysAgo } from './utils'

const DOWNLOADS = join(homedir(), 'Downloads')
const STALE_DAYS = 60
const MIN_SIZE = 1024 * 1024 // 1MB, skip tiny noise files
/** Prefer surfacing large old downloads first; still emit smaller ones above MIN_SIZE. */
const LARGE_HINT = 100 * 1024 * 1024

const INSTALLER_EXT = new Set([
  '.dmg',
  '.pkg',
  '.iso',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.xz',
  '.7z',
  '.rar'
])

export async function scanOldDownloads(
  emit: (item: ScanItem) => void,
  progress: (msg: string) => void
): Promise<void> {
  if (!(await pathExists(DOWNLOADS))) return
  progress('Scanning Downloads')

  for await (const { path, stat } of walkFiles(DOWNLOADS, { maxEntries: 50_000 })) {
    if (stat.size < MIN_SIZE) continue
    const age = daysAgo(stat.mtime)
    if (age < STALE_DAYS) continue

    const ext = basename(path).includes('.')
      ? basename(path).slice(basename(path).lastIndexOf('.')).toLowerCase()
      : ''
    const isInstaller = INSTALLER_EXT.has(ext)
    const sizeHint =
      stat.size >= LARGE_HINT ? 'large · ' : isInstaller ? 'installer · ' : ''

    emit({
      id: `oldDownloads:${path}`,
      path,
      name: basename(path),
      sizeBytes: stat.size,
      reason: `${sizeHint}Untouched for ${age} days`,
      category: 'oldDownloads',
      action: { kind: 'trash' }
    })
  }
}
