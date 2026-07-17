import { ElectronAPI } from '@electron-toolkit/preload'
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
  agent: {
    ask: (request: BytemapAgentRequest) => Promise<BytemapAgentResponse>
    reset: (sessionId: string) => Promise<void>
    cancel: (requestId: string, sessionId: string) => Promise<{ ok: boolean; reason?: string }>
    providers: () => Promise<OmpProviderSnapshot>
    loginProvider: (providerId: string) => Promise<OmpProviderSnapshot>
    setProviderApiKey: (providerId: string, apiKey: string) => Promise<OmpProviderSnapshot>
    logoutProvider: (providerId: string) => Promise<OmpProviderSnapshot>
    selectModel: (modelId: string) => Promise<void>
    onEvent: (cb: (event: BytemapAgentEvent) => void) => () => void
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
    getVolumeStats: (path?: string) => Promise<VolumeStats>
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
