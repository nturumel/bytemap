import { execFile } from 'child_process'
import { readdir, stat, statfs } from 'fs/promises'
import { homedir } from 'os'
import { basename, join } from 'path'
import { promisify } from 'util'
import type { VolumeStats } from '@shared/types'

const execFileAsync = promisify(execFile)

const NETWORK_FS_TYPES = new Set(['smbfs', 'afpfs', 'nfs', 'webdav', 'cifs', 'ftp'])

async function readVolumeMeta(probePath: string): Promise<{
  volumeName: string | null
  mountPoint: string
  fileSystem: string | null
}> {
  try {
    const { stdout } = await execFileAsync('diskutil', ['info', probePath], { timeout: 3000 })
    const volumeName = stdout.match(/^\s*Volume Name:\s*(.+)$/m)?.[1]?.trim() || null
    const mountPoint = stdout.match(/^\s*Mount Point:\s*(.+)$/m)?.[1]?.trim() || probePath
    const fileSystem =
      stdout.match(/^\s*File System Personality:\s*(.+)$/m)?.[1]?.trim() ||
      stdout.match(/^\s*Name \(User Visible\):\s*(.+)$/m)?.[1]?.trim() ||
      null
    return {
      volumeName: volumeName && volumeName !== 'Not applicable' ? volumeName : null,
      mountPoint,
      fileSystem
    }
  } catch {
    return { volumeName: null, mountPoint: probePath, fileSystem: null }
  }
}

/** Local non-boot volumes under /Volumes (same filters as large-file scans). */
async function summarizeOtherVolumes(): Promise<{
  otherVolumeCount: number
  otherVolumesFreeBytes: number
}> {
  let bootDeviceId: number
  try {
    bootDeviceId = (await stat('/')).dev
  } catch {
    return { otherVolumeCount: 0, otherVolumesFreeBytes: 0 }
  }

  let entries: string[]
  try {
    entries = await readdir('/Volumes')
  } catch {
    return { otherVolumeCount: 0, otherVolumesFreeBytes: 0 }
  }

  let mountOutput = ''
  try {
    mountOutput = (await execFileAsync('mount', [], { timeout: 2000 })).stdout
  } catch {
    return { otherVolumeCount: 0, otherVolumesFreeBytes: 0 }
  }

  let otherVolumeCount = 0
  let otherVolumesFreeBytes = 0

  for (const name of entries) {
    const full = join('/Volumes', name)
    const st = await stat(full).catch(() => null)
    if (!st || st.dev === bootDeviceId) continue

    const mountLine = mountOutput.split('\n').find((line) => line.includes(` on ${full} `))
    const fsType = mountLine?.match(/\(([^,)]+)/)?.[1]
    if (fsType && NETWORK_FS_TYPES.has(fsType)) continue

    otherVolumeCount += 1
    try {
      const fs = await statfs(full)
      otherVolumesFreeBytes += Number(fs.bavail) * Number(fs.bsize)
    } catch {
      // volume may be locked / ejecting
    }
  }

  return { otherVolumeCount, otherVolumesFreeBytes }
}

/**
 * Whole-volume capacity for the filesystem containing `probePath`.
 * Used/free/total from statfs — not Apple's Apps / Documents / System categories.
 */
export async function getVolumeStats(probePath = '/'): Promise<VolumeStats> {
  const [s, meta, others] = await Promise.all([
    statfs(probePath),
    readVolumeMeta(probePath),
    summarizeOtherVolumes()
  ])

  const totalBytes = Number(s.blocks) * Number(s.bsize)
  const freeBytes = Number(s.bavail) * Number(s.bsize)
  const usedBytes = Math.max(0, totalBytes - freeBytes)
  const home = homedir()

  return {
    path: probePath,
    totalBytes,
    freeBytes,
    usedBytes,
    usedRatio: totalBytes > 0 ? usedBytes / totalBytes : 0,
    volumeName: meta.volumeName,
    mountPoint: meta.mountPoint,
    fileSystem: meta.fileSystem,
    otherVolumeCount: others.otherVolumeCount,
    otherVolumesFreeBytes: others.otherVolumesFreeBytes,
    mapRootLabel: basename(home) || 'Home'
  }
}
