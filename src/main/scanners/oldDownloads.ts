import { homedir } from 'os'
import { basename, join } from 'path'
import type { ScanItem } from '@shared/types'
import { walkFiles, pathExists, daysAgo } from './utils'

const DOWNLOADS = join(homedir(), 'Downloads')
const STALE_DAYS = 60
const MIN_SIZE = 1024 * 1024 // 1MB, skip tiny noise files

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

    emit({
      id: `oldDownloads:${path}`,
      path,
      name: basename(path),
      sizeBytes: stat.size,
      reason: `Untouched for ${age} days`,
      category: 'oldDownloads'
    })
  }
}
