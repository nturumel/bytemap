import type { BytemapAgentContext, DiskNode, ScanItem, VolumeStats } from '@shared/types'
import { classifyPath } from '@shared/cleanupTargets'

export function buildFreeChatAgentContext(): BytemapAgentContext {
  return { kind: 'freeChat', phase: 'idle', view: 'global', subjects: [] }
}

export function buildGlobalScanAgentContext(args: {
  phase: string
  items: ScanItem[]
  selectedIds?: Set<string>
}): BytemapAgentContext {
  const selected = args.selectedIds
    ? args.items.filter((item) => args.selectedIds?.has(item.id))
    : []
  const source = selected.length ? selected : args.items.slice(0, 50)
  return {
    kind: selected.length ? 'cleanupSelection' : 'globalScan',
    phase: args.phase,
    view: 'cleanup',
    summary: {
      totalItems: args.items.length,
      selectedItems: selected.length,
      visibleSubjectsCapped: source.length
    },
    subjects: source.map(scanItemToSubject)
  }
}

export function buildDiskMapAgentContext(args: {
  breadcrumbs: { name: string; path: string | null }[]
  children: DiskNode[]
  selectedNode: DiskNode | null
  volumeStats: VolumeStats | null
  loading: boolean
  refreshing: boolean
}): BytemapAgentContext {
  const visible = args.children.slice(0, 50)
  const selected = args.selectedNode ? [diskNodeToSubject(args.selectedNode)] : []
  return {
    kind: args.selectedNode ? 'visualTile' : 'diskMapView',
    phase: args.loading ? 'loading' : args.refreshing ? 'refreshing' : 'ready',
    view: 'diskMap',
    summary: {
      breadcrumbs: args.breadcrumbs,
      visibleNodeCount: args.children.length,
      visibleSubjectsCapped: visible.length,
      volumeStats: args.volumeStats
        ? {
            path: args.volumeStats.path,
            totalBytes: args.volumeStats.totalBytes,
            freeBytes: args.volumeStats.freeBytes,
            usedBytes: args.volumeStats.usedBytes,
            usedRatio: args.volumeStats.usedRatio,
            volumeName: args.volumeStats.volumeName,
            mountPoint: args.volumeStats.mountPoint,
            fileSystem: args.volumeStats.fileSystem
          }
        : null
    },
    subjects: selected.length ? selected : visible.map(diskNodeToSubject)
  }
}

export function scanItemToSubject(item: ScanItem): BytemapAgentContext['subjects'][number] {
  return {
    id: item.id,
    path: item.path,
    name: item.name,
    sizeBytes: item.sizeBytes,
    isDir: undefined,
    category: item.category,
    reason: item.reason,
    action: item.action,
    deletable: item.deletable,
    keptInsteadOf: item.keptInsteadOf
  }
}

function diskNodeToSubject(node: DiskNode): BytemapAgentContext['subjects'][number] {
  const classification = classifyPath(node.path, node.name)
  return {
    id: node.path,
    path: node.path,
    name: node.name,
    sizeBytes: node.size,
    isDir: node.isDir,
    cleanupTier: classification?.tier,
    cleanupLabel: classification?.label,
    cleanupReason: classification?.reason
  }
}
