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
  /** SMAppService.register only works from a Developer-signed packaged Bytemap.app. */
  canRegister: boolean
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
  /**
   * When false, the item is informational only (e.g. SIP-sealed Simulator runtimes).
   * Defaults to true.
   */
  deletable?: boolean
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
    description: 'Regenerable caches, logs, Xcode data, and leftover app folders'
  },
  {
    id: 'oldDownloads',
    label: 'Old downloads',
    description: 'Files in ~/Downloads untouched for 60+ days (large/installers prioritized)'
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

/** Coalesced filesystem change from the disk watcher (main → renderer). */
export interface DiskChangeEvent {
  root: string
  paths: string[]
  childNames: string[]
  generation: number
  selfTriggered: boolean
}

/** Capacity of the volume containing a path (whole-disk used vs free — not a treemap breakdown). */
export interface VolumeStats {
  /** Path used for the statfs probe (usually "/"). */
  path: string
  totalBytes: number
  /** Space available to non-root (bavail). */
  freeBytes: number
  /** totalBytes − freeBytes. */
  usedBytes: number
  /** usedBytes / totalBytes, 0–1. */
  usedRatio: number
  /** User-visible name from diskutil, e.g. "Macintosh HD". */
  volumeName: string | null
  /** Mount point reported by diskutil (falls back to probe path). */
  mountPoint: string
  /** File system personality when known, e.g. "APFS". */
  fileSystem: string | null
  /** Other local non-boot volumes under /Volumes (excludes network mounts). */
  otherVolumeCount: number
  /** Sum of free space across those other volumes. */
  otherVolumesFreeBytes: number
  /** Basename of the home folder — treemap/scan scope, not whole-disk capacity. */
  mapRootLabel: string
}

export type BytemapAgentContextKind =
  | 'globalScan'
  | 'cleanupSelection'
  | 'confirmCleanup'
  | 'deleteFailure'
  | 'permissionIssue'
  | 'visualTile'
  | 'diskMapView'
  | 'cloudReady'
  | 'freeChat'

export type BytemapAgentSubject = {
  id: string
  path?: string
  name: string
  sizeBytes?: number
  isDir?: boolean
  category?: string
  reason?: string
  action?: unknown
  deletable?: boolean
  keptInsteadOf?: string
  error?: string
  cleanupTier?: string
  cleanupLabel?: string
  cleanupReason?: string
  cloudProvider?: string
  cloudBackupStatus?: string
}

export type BytemapAgentContext = {
  kind: BytemapAgentContextKind
  phase?: string
  view?: string
  summary?: string | Record<string, unknown>
  subjects: BytemapAgentSubject[]
}

export type BytemapAgentRequest = {
  sessionId?: string
  requestId: string
  message: string
  context: BytemapAgentContext
}

export type BytemapAgentEvent =
  | { requestId: string; sessionId: string; type: 'status'; text: string }
  | { requestId: string; sessionId: string; type: 'assistant_delta'; text: string }
  | { requestId: string; sessionId: string; type: 'thinking_delta'; text: string }
  | {
      requestId: string
      sessionId: string
      type: 'tool_start' | 'tool_update' | 'tool_end'
      toolName: string
      toolCallId?: string
      /** Formatted tool args / command for the card body (not a generic title). */
      argsText?: string
      /** Live or final tool output (stdout/stderr/result text). Full snapshots replace prior text. */
      text?: string
      ok?: boolean
    }
  | { requestId: string; sessionId: string; type: 'error'; text: string }

export type BytemapAgentResponse = {
  requestId: string
  sessionId: string
  answer: string
}

export type OmpProviderId =
  | 'anthropic'
  | 'openai-codex'
  | 'openai'
  | 'google'
  | 'google-gemini-cli'
  | 'google-antigravity'
  | 'github-copilot'
  | 'cursor'
  | 'ollama'
  | 'lm-studio'
  | 'llama.cpp'
  | string

export type OmpProviderStatus =
  | 'available'
  | 'needsLogin'
  | 'needsApiKey'
  | 'localUnavailable'
  | 'disabled'

export type OmpProviderSummary = {
  id: OmpProviderId
  label: string
  authKind: 'oauth' | 'apiKey' | 'local' | 'custom'
  status: OmpProviderStatus
  envVars: string[]
  models: { id: string; label: string; provider: string; selected: boolean }[]
  loginSupported: boolean
  logoutSupported: boolean
}

export type OmpProviderSnapshot = {
  providers: OmpProviderSummary[]
  selectedModelId: string | null
}
