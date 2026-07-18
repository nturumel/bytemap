import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  BytemapAgentEvent,
  BytemapAgentRequest,
  BytemapAgentResponse,
  DeleteRequest,
  DeleteResult,
  DiskChangeEvent,
  DiskNode,
  OmpProviderSnapshot,
  PrivilegedHelperState,
  ScanCategoryId,
  ScanDoneEvent,
  ScanItem,
  ScanProgressEvent,
  VolumeStats
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
  agent: {
    ask: (request: BytemapAgentRequest): Promise<BytemapAgentResponse> =>
      ipcRenderer.invoke('agent:ask', request),
    reset: (sessionId: string): Promise<void> => ipcRenderer.invoke('agent:reset', sessionId),
    cancel: (
      requestId: string,
      sessionId: string
    ): Promise<{ ok: boolean; reason?: string }> =>
      ipcRenderer.invoke('agent:cancel', requestId, sessionId),
    providers: (): Promise<OmpProviderSnapshot> => ipcRenderer.invoke('agent:providers'),
    loginProvider: (providerId: string): Promise<OmpProviderSnapshot> =>
      ipcRenderer.invoke('agent:loginProvider', providerId),
    setProviderApiKey: (providerId: string, apiKey: string): Promise<OmpProviderSnapshot> =>
      ipcRenderer.invoke('agent:setProviderApiKey', providerId, apiKey),
    logoutProvider: (providerId: string): Promise<OmpProviderSnapshot> =>
      ipcRenderer.invoke('agent:logoutProvider', providerId),
    selectModel: (modelId: string): Promise<void> =>
      ipcRenderer.invoke('agent:selectModel', modelId),
    onEvent: (cb: (event: BytemapAgentEvent) => void): (() => void) => {
      const listener = (_: unknown, event: BytemapAgentEvent): void => cb(event)
      ipcRenderer.on('agent:event', listener)
      return () => ipcRenderer.removeListener('agent:event', listener)
    }
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
    },
    watch: (path: string | null): Promise<void> => ipcRenderer.invoke('disk:watch', path),
    unwatch: (): Promise<void> => ipcRenderer.invoke('disk:unwatch'),
    expectChanges: (paths: string[]): Promise<void> =>
      ipcRenderer.invoke('disk:expectChanges', paths),
    onChanged: (cb: (event: DiskChangeEvent) => void): (() => void) => {
      const listener = (_: unknown, event: DiskChangeEvent): void => cb(event)
      ipcRenderer.on('disk:changed', listener)
      return () => ipcRenderer.removeListener('disk:changed', listener)
    },
    getVolumeStats: (path?: string): Promise<VolumeStats> =>
      ipcRenderer.invoke('disk:getVolumeStats', path)
  },
  shell: {
    showItemInFolder: (path: string): Promise<void> =>
      ipcRenderer.invoke('shell:showItemInFolder', path),
    openPath: (path: string): Promise<string> => ipcRenderer.invoke('shell:openPath', path)
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
