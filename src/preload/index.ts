import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  DeleteRequest,
  DeleteResult,
  DiskNode,
  PrivilegedHelperState,
  ScanCategoryId,
  ScanDoneEvent,
  ScanItem,
  ScanProgressEvent
} from '@shared/types'

// Custom APIs for renderer
const api = {
  scan: {
    start: (): Promise<ScanDoneEvent> => ipcRenderer.invoke('scan:start'),
    onProgress: (cb: (event: ScanProgressEvent) => void): (() => void) => {
      const listener = (_: unknown, event: ScanProgressEvent): void => cb(event)
      ipcRenderer.on('scan:progress', listener)
      return () => ipcRenderer.removeListener('scan:progress', listener)
    },
    onItem: (cb: (item: ScanItem) => void): (() => void) => {
      const listener = (_: unknown, item: ScanItem): void => cb(item)
      ipcRenderer.on('scan:item', listener)
      return () => ipcRenderer.removeListener('scan:item', listener)
    },
    onCategoryDone: (cb: (event: { category: ScanCategoryId }) => void): (() => void) => {
      const listener = (_: unknown, event: { category: ScanCategoryId }): void => cb(event)
      ipcRenderer.on('scan:category-done', listener)
      return () => ipcRenderer.removeListener('scan:category-done', listener)
    }
  },
  deleteItems: (request: DeleteRequest): Promise<DeleteResult[]> =>
    ipcRenderer.invoke('delete:items', request),
  deleteHelperItems: (request: DeleteRequest): Promise<DeleteResult[]> =>
    ipcRenderer.invoke('delete:helperItems', request),
  helper: {
    status: (): Promise<PrivilegedHelperState> => ipcRenderer.invoke('helper:status'),
    register: (): Promise<PrivilegedHelperState> => ipcRenderer.invoke('helper:register')
  },
  system: {
    checkFullDiskAccess: (): Promise<boolean> => ipcRenderer.invoke('system:fullDiskAccess'),
    openFullDiskAccessSettings: (): Promise<void> =>
      ipcRenderer.invoke('system:openFullDiskAccessSettings'),
    onFullDiskAccessChanged: (cb: (granted: boolean) => void): (() => void) => {
      const listener = (_: unknown, granted: boolean): void => cb(granted)
      ipcRenderer.on('system:fullDiskAccessChanged', listener)
      return () => ipcRenderer.removeListener('system:fullDiskAccessChanged', listener)
    }
  },
  disk: {
    breakdown: (path: string | null): Promise<void> => ipcRenderer.invoke('disk:breakdown', path),
    cancelBreakdown: (): Promise<void> => ipcRenderer.invoke('disk:cancelBreakdown'),
    onChild: (cb: (node: DiskNode) => void): (() => void) => {
      const listener = (_: unknown, node: DiskNode): void => cb(node)
      ipcRenderer.on('disk:breakdown-child', listener)
      return () => ipcRenderer.removeListener('disk:breakdown-child', listener)
    }
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
