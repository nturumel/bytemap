import type { DiskNode } from '@shared/types'
import {
  ScannerGrpcRuntimeClient,
  type ScannerDuplicateGroup,
  type ScannerFileEntry
} from './scannerGrpcClient'

const scanner = new ScannerGrpcRuntimeClient()

export function dirSize(path: string): Promise<number> {
  return scanner.dirSize(path)
}

export function dirSizes(paths: string[]): Promise<number[]> {
  return paths.length === 0 ? Promise.resolve([]) : scanner.dirSizes(paths)
}

export type NativeFileEntry = ScannerFileEntry

export function findLargeFiles(
  roots: string[],
  threshold: number,
  onProgress: (msg: string) => void
): Promise<NativeFileEntry[]> {
  return scanner.findLargeFiles(roots, threshold, onProgress)
}

export type NativeDuplicateGroup = ScannerDuplicateGroup

export function findDuplicates(
  roots: string[],
  minSize: number,
  cacheDbPath: string,
  onProgress: (msg: string) => void
): Promise<NativeDuplicateGroup[]> {
  return scanner.findDuplicates(roots, minSize, cacheDbPath, onProgress)
}

/** Streams each immediate child of `path` (expanded `maxDepth` levels deep) as it's sized. */
export function dirBreakdownStream(
  path: string,
  maxDepth: number,
  onChild: (node: DiskNode) => void,
  requestId?: string
): Promise<void> {
  return scanner.dirBreakdownStream(path, maxDepth, onChild, requestId)
}

export function cancelDirBreakdown(requestId: string): Promise<{ ok: boolean; reason?: string }> {
  return scanner.cancel(requestId)
}

export function disposeScannerRuntime(): Promise<void> {
  return scanner.disposeAll()
}
