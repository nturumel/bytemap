// Relative depth matches between src/main/ and out/main/ (both two levels below project
// root), so this same specifier resolves correctly whether Node is running the raw source
// (dev) or the bundled output (prod) — see electron.vite.config.ts's `external` entry.
import * as native from '../../native'
import type { DiskNode } from '@shared/types'

export function dirSize(path: string): Promise<number> {
  return native.dirSize(path)
}

export function dirSizes(paths: string[]): Promise<number[]> {
  return paths.length === 0 ? Promise.resolve([]) : native.dirSizes(paths)
}

export interface NativeFileEntry {
  path: string
  size: number
  mtimeMs: number
}

export function findLargeFiles(
  roots: string[],
  threshold: number,
  onProgress: (msg: string) => void
): Promise<NativeFileEntry[]> {
  return native.findLargeFiles(roots, threshold, (err, msg) => {
    if (!err) onProgress(msg)
  })
}

export interface NativeDuplicateGroup {
  size: number
  keeper: string
  duplicates: string[]
}

export function findDuplicates(
  roots: string[],
  minSize: number,
  cacheDbPath: string,
  onProgress: (msg: string) => void
): Promise<NativeDuplicateGroup[]> {
  return native.findDuplicates(roots, minSize, cacheDbPath, (err, msg) => {
    if (!err) onProgress(msg)
  })
}

/** Streams each immediate child of `path` (expanded `maxDepth` levels deep) as it's sized. */
export function dirBreakdownStream(
  path: string,
  maxDepth: number,
  onChild: (node: DiskNode) => void
): Promise<void> {
  return native.dirBreakdownStream(path, maxDepth, (err, node) => {
    if (!err) onChild(node)
  })
}
