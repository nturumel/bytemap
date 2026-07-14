import { promises as fs } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'
import type { ScanItem } from '@shared/types'
import { duSizeBytesBatch, pathExists, formatBytes } from './utils'

const THRESHOLD = 50 * 1024 * 1024

/** Folders under Application Support that are system / shared — never flag as leftovers. */
const AS_ALLOWLIST = new Set([
  'AddressBook',
  'Apple',
  'CallHistoryDB',
  'CallHistoryTransactions',
  'CloudDocs',
  'CrashReporter',
  'DiskImages',
  'FaceTime',
  'FileProvider',
  'Google',
  'Knowledge',
  'Microsoft',
  'MobileSync',
  'SyncServices',
  'com.apple.sharedfilelist',
  'com.apple.TCC',
  'com.apple.control-center.tips',
  'com.apple.mediaanalysisd',
  'com.apple.MediaPlayer',
  'com.apple.ProtectedCloudStorage',
  'com.apple.akd',
  'com.apple.spotlight',
  'iCloud',
  'iDrive',
  'icloud'
])

async function installedAppNames(): Promise<Set<string>> {
  const names = new Set<string>()
  const roots = ['/Applications', join(homedir(), 'Applications')]
  for (const root of roots) {
    if (!(await pathExists(root))) continue
    let entries: string[]
    try {
      entries = await fs.readdir(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.endsWith('.app')) continue
      const base = entry.slice(0, -4).toLowerCase()
      names.add(base)
      names.add(base.replace(/\s+/g, ''))
      names.add(base.replace(/[^a-z0-9]/g, ''))
    }
  }
  return names
}

function looksInstalled(folderName: string, apps: Set<string>): boolean {
  const lower = folderName.toLowerCase()
  if (apps.has(lower) || apps.has(lower.replace(/\s+/g, '')) || apps.has(lower.replace(/[^a-z0-9]/g, ''))) {
    return true
  }
  // Bundle-id style (com.vendor.app) — match last component against apps loosely.
  if (folderName.includes('.')) {
    const last = folderName.split('.').pop()?.toLowerCase() ?? ''
    if (last && (apps.has(last) || [...apps].some((a) => a.includes(last) || last.includes(a)))) {
      return true
    }
  }
  // Partial: "Slack Helper" leftovers vs Slack.app
  for (const app of apps) {
    if (app.length >= 4 && (lower.includes(app) || app.includes(lower))) return true
  }
  return false
}

/**
 * Application Support folders whose owning app no longer appears in /Applications.
 * Emitted as caution items (Trash) — never permanent remove.
 */
export async function scanAppLeftovers(
  emit: (item: ScanItem) => void,
  progress: (msg: string) => void
): Promise<void> {
  const support = join(homedir(), 'Library', 'Application Support')
  if (!(await pathExists(support))) return
  progress('Looking for leftover app data')

  const apps = await installedAppNames()
  let entries: string[]
  try {
    entries = await fs.readdir(support)
  } catch {
    return
  }

  const candidates: string[] = []
  for (const name of entries) {
    if (name.startsWith('.')) continue
    if (AS_ALLOWLIST.has(name)) continue
    if (name.startsWith('com.apple.')) continue
    if (looksInstalled(name, apps)) continue
    candidates.push(join(support, name))
  }

  if (candidates.length === 0) return
  const sizes = await duSizeBytesBatch(candidates)
  candidates.forEach((path, i) => {
    const size = sizes[i]
    if (size < THRESHOLD) return
    emit({
      id: `caches:leftover:${path}`,
      path,
      name: `Leftover: ${basename(path)}`,
      sizeBytes: size,
      reason: `${formatBytes(size)} — no matching app in Applications (review before Trash)`,
      category: 'caches',
      action: { kind: 'trash' }
    })
  })
}
