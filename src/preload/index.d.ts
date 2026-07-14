import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  DeleteRequest,
  DeleteResult,
  DiskChangeEvent,
  DiskNode,
  PrivilegedHelperState,
  ScanCategoryId,
  ScanDoneEvent,
  ScanItem,
  ScanProgressEvent
} from '@shared/types'

export interface PreloadApi {
  scan: {
    start: () => Promise<ScanDoneEvent>
    onProgress: (cb: (event: ScanProgressEvent) => void) => () => void
    onItem: (cb: (item: ScanItem) => void) => () => void
    onCategoryDone: (cb: (event: { category: ScanCategoryId }) => void) => () => void
  }
  deleteItems: (request: DeleteRequest) => Promise<DeleteResult[]>
  deleteHelperItems: (request: DeleteRequest) => Promise<DeleteResult[]>
  helper: {
    status: () => Promise<PrivilegedHelperState>
    register: () => Promise<PrivilegedHelperState>
  }
  system: {
    checkFullDiskAccess: () => Promise<boolean>
    openFullDiskAccessSettings: () => Promise<void>
    onFullDiskAccessChanged: (cb: (granted: boolean) => void) => () => void
  }
  disk: {
    breakdown: (path: string | null) => Promise<void>
    cancelBreakdown: () => Promise<void>
    onChild: (cb: (node: DiskNode) => void) => () => void
    watch: (path: string | null) => Promise<void>
    unwatch: () => Promise<void>
    expectChanges: (paths: string[]) => Promise<void>
    onChanged: (cb: (event: DiskChangeEvent) => void) => () => void
  }
  shell: {
    showItemInFolder: (path: string) => Promise<void>
    openPath: (path: string) => Promise<string>
  }
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: PreloadApi
  }
}
