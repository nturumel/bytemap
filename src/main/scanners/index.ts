import type { ScanCategoryId, ScanItem } from '@shared/types'
import { scanUnusedApps } from './unusedApps'
import { scanDuplicates } from './duplicates'
import { scanLargeFiles } from './largeFiles'
import { scanCaches } from './caches'
import { scanOldDownloads } from './oldDownloads'

type Scanner = (emit: (item: ScanItem) => void, progress: (msg: string) => void) => Promise<void>

export interface RunScanCallbacks {
  onProgress: (category: ScanCategoryId, message: string) => void
  onItem: (item: ScanItem) => void
  onCategoryDone: (category: ScanCategoryId) => void
}

export async function runScan(callbacks: RunScanCallbacks, cacheDbPath: string): Promise<void> {
  const scanners: Record<ScanCategoryId, Scanner> = {
    unusedApps: scanUnusedApps,
    duplicates: (emit, progress) => scanDuplicates(emit, progress, cacheDbPath),
    largeFiles: scanLargeFiles,
    caches: scanCaches,
    oldDownloads: scanOldDownloads
  }
  const categories = Object.keys(scanners) as ScanCategoryId[]

  // Each scanner is I/O-bound (disk reads, `mdls`/`docker` subprocesses, native scans), so
  // running them concurrently overlaps their wait time instead of paying for it serially.
  await Promise.all(
    categories.map(async (category) => {
      try {
        await scanners[category](
          (item) => callbacks.onItem(item),
          (message) => callbacks.onProgress(category, message)
        )
      } catch (err) {
        callbacks.onProgress(category, `Failed: ${(err as Error).message}`)
      }
      callbacks.onCategoryDone(category)
    })
  )
}
