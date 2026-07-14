import type { ScanItemAction } from './types'

/** How confidently Bytemap recommends acting on a path. */
export type CleanupTier = 'safe' | 'caution' | 'inspect' | 'protected'

export type CleanupActionKind = 'clearCache' | 'trash' | 'inspectOnly' | 'none'

export interface CleanupTarget {
  tier: CleanupTier
  /** Short label for badge / callout */
  label: string
  /** One-line explanation */
  reason: string
  primaryAction: CleanupActionKind
  /** How deleteItems should execute when primaryAction is clearCache or trash */
  scanAction?: ScanItemAction
}

const SAFE_EXACT_NAMES = new Set([
  'Caches',
  '.cache',
  'DerivedData',
  'Logs',
  'log',
  'logs',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.next',
  '.turbo',
  '.parcel-cache',
  'ModuleCache.noindex',
  'DocumentationCache'
])

const CAUTION_EXACT_NAMES = new Set([
  'node_modules',
  'target',
  'build',
  'dist',
  'Archives',
  'iOS DeviceSupport',
  'watchOS DeviceSupport',
  'CoreSimulator',
  '.git'
])

/** Path segments that mean "do not suggest bulk delete". */
const PROTECTED_SEGMENTS = [
  '/Library/Containers/',
  '/Library/Group Containers/',
  '/Library/Mail/',
  '/Library/Messages/',
  '/Library/Keychains/',
  '/Library/Shortcuts/',
  '/Library/IntelligencePlatform/',
  '/Library/Daemon Containers/'
]

const PROTECTED_NAMES = new Set([
  'Containers',
  'Group Containers',
  'Application Support',
  'Preferences',
  'Cookies',
  'Saved Application State',
  'Mobile Documents',
  'Photos Library.photoslibrary',
  'Messages',
  'Mail',
  'HomeKit',
  'Accounts',
  'Calendars',
  'Reminders',
  'Safari'
])

const OPAQUE_SUFFIXES = [
  '.photoslibrary',
  '.sparsebundle',
  '.imovielibrary',
  '.tvlibrary',
  '.fcpbundle',
  '.band',
  '.app'
]

function pathHasSegment(path: string, segment: string): boolean {
  const parts = path.split('/')
  return parts.includes(segment)
}

function endsWithOpaque(name: string): boolean {
  return OPAQUE_SUFFIXES.some((s) => name.endsWith(s))
}

/**
 * Classify a visualized path for reclaimability callouts and tile actions.
 * Pure heuristics — no I/O. Prefer false negatives over dangerous positives.
 */
export function classifyPath(path: string, name: string): CleanupTarget | null {
  if (!path && !name) return null

  const lowerPath = path.replace(/\\/g, '/')

  for (const seg of PROTECTED_SEGMENTS) {
    if (lowerPath.includes(seg)) {
      return {
        tier: 'protected',
        label: 'Protected',
        reason: 'App sandbox / personal data — inspect only; never bulk-cleared',
        primaryAction: 'inspectOnly'
      }
    }
  }

  if (PROTECTED_NAMES.has(name) || endsWithOpaque(name)) {
    return {
      tier: 'protected',
      label: 'Protected',
      reason: endsWithOpaque(name)
        ? 'App-managed library or bundle — open in Finder if you need to act'
        : 'System or app data container — not safe to clear wholesale',
      primaryAction: 'inspectOnly'
    }
  }

  // Mail / Messages attachments living outside Containers still get caution.
  if (
    pathHasSegment(lowerPath, 'Mail Downloads') ||
    (pathHasSegment(lowerPath, 'Attachments') &&
      (lowerPath.includes('/Messages/') || lowerPath.includes('/Mail/')))
  ) {
    return {
      tier: 'caution',
      label: 'Attachments',
      reason: 'May contain unique messages or files — review before deleting',
      primaryAction: 'trash',
      scanAction: { kind: 'trash' }
    }
  }

  if (SAFE_EXACT_NAMES.has(name)) {
    return {
      tier: 'safe',
      label: 'Safe clear',
      reason: 'Regenerable cache or logs',
      primaryAction: 'clearCache',
      scanAction: { kind: 'remove' }
    }
  }

  // Named package-manager / toolchain caches by path.
  if (
    /\/\.npm\/_cacache(\/|$)/.test(lowerPath) ||
    /\/\.yarn\/cache(\/|$)/.test(lowerPath) ||
    /\/pnpm\/store(\/|$)/.test(lowerPath) ||
    /\/\.cargo\/(registry|git)(\/|$)/.test(lowerPath) ||
    /\/\.gradle\/caches(\/|$)/.test(lowerPath) ||
    /\/\.cache\/(pip|huggingface|uv|torch|whisper)(\/|$)/.test(lowerPath) ||
    /\/go\/pkg\/mod(\/|$)/.test(lowerPath) ||
    /\/Library\/Caches\//.test(lowerPath) ||
    /\/Library\/Logs(\/|$)/.test(lowerPath) ||
    /\/Library\/Developer\/Xcode\/DerivedData(\/|$)/.test(lowerPath) ||
    /\/Homebrew\/(Caches|logs)(\/|$)/i.test(lowerPath)
  ) {
    // Never treat Containers-backed caches as safe remove of the whole Containers tree —
    // those were caught above. Library/Caches/* entries are safe.
    return {
      tier: 'safe',
      label: 'Safe clear',
      reason: 'Tooling or app cache — regenerates when needed',
      primaryAction: 'clearCache',
      scanAction: { kind: 'remove' }
    }
  }

  // Editor tooling: Cursor / VS Code caches are regenerable; extensions are reinstallable.
  if (
    /\/\.(cursor|vscode|code-server)\/(CachedData|CachedExtensionVSIXs|Code Cache|GPUCache|DawnCache|logs)(\/|$)/i.test(
      lowerPath
    ) ||
    (/\/\.(cursor|vscode)\//.test(lowerPath) &&
      (name === 'CachedData' ||
        name === 'CachedExtensionVSIXs' ||
        name === 'Code Cache' ||
        name === 'GPUCache' ||
        name === 'DawnCache' ||
        name === 'logs'))
  ) {
    return {
      tier: 'safe',
      label: 'Editor cache',
      reason: 'Cursor/VS Code cache — regenerates on next launch',
      primaryAction: 'clearCache',
      scanAction: { kind: 'remove' }
    }
  }

  if (
    (/\/\.(cursor|vscode)\//.test(lowerPath) && name === 'extensions') ||
    /\/\.(cursor|vscode)\/extensions(\/|$)/.test(lowerPath)
  ) {
    return {
      tier: 'caution',
      label: 'Editor extensions',
      reason: 'Installed extensions — trash only if you can reinstall what you need',
      primaryAction: 'trash',
      scanAction: { kind: 'trash' }
    }
  }

  if (CAUTION_EXACT_NAMES.has(name)) {
    const isDevArtifact = name === 'node_modules' || name === 'target' || name === 'dist' || name === 'build'
    return {
      tier: 'caution',
      label: isDevArtifact ? 'Dev artifact' : 'Caution',
      reason: isDevArtifact
        ? 'Can be large; projects reclaim on next install/build'
        : 'Large or regenerable with more rebuild cost — confirm first',
      primaryAction: 'trash',
      scanAction: { kind: 'trash' }
    }
  }

  if (
    /\/Library\/Developer\/Xcode\/(Archives|iOS DeviceSupport|watchOS DeviceSupport)(\/|$)/.test(
      lowerPath
    ) ||
    /\/Library\/Developer\/CoreSimulator(\/|$)/.test(lowerPath)
  ) {
    return {
      tier: 'caution',
      label: 'Xcode data',
      reason: 'Archives / device symbols / simulators — safe if you do not need old builds',
      primaryAction: 'trash',
      scanAction: { kind: 'trash' }
    }
  }

  if (/\/Downloads\//.test(lowerPath) || name === 'Downloads') {
    return {
      tier: 'caution',
      label: 'Downloads',
      reason: 'User files — trash only after review',
      primaryAction: 'trash',
      scanAction: { kind: 'trash' }
    }
  }

  // Leftover Application Support tipped by scanner uses path id prefix in reason elsewhere;
  // here we only mark AS children as inspect by default (never auto-safe).
  if (/\/Library\/Application Support\/[^/]+$/.test(lowerPath)) {
    return {
      tier: 'inspect',
      label: 'App data',
      reason: 'May be leftovers or active app data — verify the app is gone first',
      primaryAction: 'inspectOnly'
    }
  }

  return null
}

/** Sort key for cycling suggested targets (N): safe first, then caution, then inspect. */
export function tierPriority(tier: CleanupTier): number {
  switch (tier) {
    case 'safe':
      return 0
    case 'caution':
      return 1
    case 'inspect':
      return 2
    case 'protected':
      return 3
  }
}

export function isActionableTarget(target: CleanupTarget): boolean {
  return target.primaryAction === 'clearCache' || target.primaryAction === 'trash'
}
