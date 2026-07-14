import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

// macOS's real app-usage history — far more complete than Spotlight's kMDItemLastUsedDate,
// but TCC-protected: reading it requires the process to have Full Disk Access.
const KNOWLEDGE_DB_PATH = '/private/var/db/CoreDuet/Knowledge/knowledgeC.db'
const CORE_DATA_EPOCH_OFFSET = 978307200 // seconds between 2001-01-01 and 1970-01-01 (both UTC)

let fullDiskAccessCache: boolean | null = null

async function checkFullDiskAccess(): Promise<boolean> {
  try {
    await execFileAsync('sqlite3', ['-readonly', KNOWLEDGE_DB_PATH, 'SELECT 1;'])
    return true
  } catch {
    return false
  }
}

/** Cached for the duration of a scan (many apps check this); use `refreshFullDiskAccess` after the user may have changed the setting. */
export async function hasFullDiskAccess(): Promise<boolean> {
  if (fullDiskAccessCache === null) fullDiskAccessCache = await checkFullDiskAccess()
  return fullDiskAccessCache
}

/** Re-checks and updates the cache — call this when the user returns from System Settings. */
export async function refreshFullDiskAccess(): Promise<boolean> {
  fullDiskAccessCache = await checkFullDiskAccess()
  return fullDiskAccessCache
}

export async function bundleIdentifier(appPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('mdls', [
      '-name',
      'kMDItemCFBundleIdentifier',
      '-raw',
      appPath
    ])
    const trimmed = stdout.trim()
    return !trimmed || trimmed === '(null)' ? null : trimmed
  } catch {
    return null
  }
}

/** Last-opened date for an app from macOS's usage-tracking database (requires Full Disk Access). */
export async function lastUsedFromUsageDB(bundleId: string): Promise<Date | null> {
  if (!(await hasFullDiskAccess())) return null

  const escaped = bundleId.replace(/'/g, "''")
  const query = `SELECT MAX(ZSTARTDATE) FROM ZOBJECT WHERE ZSTREAMNAME='/app/usage' AND ZVALUESTRING='${escaped}';`
  try {
    const { stdout } = await execFileAsync('sqlite3', ['-readonly', KNOWLEDGE_DB_PATH, query])
    const coreDataSeconds = parseFloat(stdout.trim())
    if (!Number.isFinite(coreDataSeconds)) return null
    return new Date((coreDataSeconds + CORE_DATA_EPOCH_OFFSET) * 1000)
  } catch {
    return null
  }
}
