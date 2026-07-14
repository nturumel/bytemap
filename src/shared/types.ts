export type ScanCategoryId = 'unusedApps' | 'duplicates' | 'largeFiles' | 'caches' | 'oldDownloads'

export type DockerPruneTarget = 'images' | 'containers' | 'volumes' | 'buildCache'

export type ScanItemAction =
  | { kind: 'trash' }
  | { kind: 'remove' }
  | { kind: 'dockerPrune'; target: DockerPruneTarget }

/** Delete failed because the path needs the privileged helper and it is not installed yet. */
export const HELPER_REQUIRED = 'HELPER_REQUIRED'

export type PrivilegedHelperStatus = 'enabled' | 'requiresApproval' | 'notRegistered' | 'unavailable'

export interface PrivilegedHelperState {
  status: PrivilegedHelperStatus
  /** Whether BytemapHelperCtl is present (packaged app / built helper). */
  ctlAvailable: boolean
}

export interface ScanItem {
  id: string
  path: string
  name: string
  sizeBytes: number
  reason: string
  category: ScanCategoryId
  /** For duplicate groups: the sibling paths being kept instead of this one. */
  keptInsteadOf?: string
  lastUsed?: string
  /** How "delete" is actually carried out. Defaults to moving `path` to Trash. */
  action?: ScanItemAction
}

export interface ScanCategoryMeta {
  id: ScanCategoryId
  label: string
  description: string
}

export const SCAN_CATEGORIES: ScanCategoryMeta[] = [
  {
    id: 'unusedApps',
    label: 'Unused apps',
    description: "Apps in /Applications you haven't opened in 90+ days"
  },
  {
    id: 'duplicates',
    label: 'Duplicate files',
    description: 'Byte-identical files — the oldest copy in each group is kept'
  },
  {
    id: 'largeFiles',
    label: 'Large files',
    description: 'Files over 500 MB in your home folder'
  },
  {
    id: 'caches',
    label: 'Caches & logs',
    description: 'Regenerable cache/log folders (dev tool caches, app logs)'
  },
  {
    id: 'oldDownloads',
    label: 'Old downloads',
    description: 'Files in ~/Downloads untouched for 60+ days'
  }
]

export interface ScanProgressEvent {
  category: ScanCategoryId
  message: string
}

export interface ScanCategoryResultEvent {
  category: ScanCategoryId
  items: ScanItem[]
}

export interface ScanDoneEvent {
  durationMs: number
}

export interface DeleteResult {
  id: string
  path: string
  ok: boolean
  error?: string
}

export interface DeleteRequest {
  items: { id: string; path: string; action?: ScanItemAction }[]
}

export interface DiskNode {
  name: string
  path: string
  size: number
  isDir: boolean
  children?: DiskNode[]
}
