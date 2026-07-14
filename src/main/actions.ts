import { app, shell } from 'electron'
import { access, constants, rm } from 'fs/promises'
import { dirname } from 'path'
import type { DeleteResult, ScanItemAction } from '@shared/types'
import { HELPER_REQUIRED } from '@shared/types'
import { runDockerPrune } from './scanners/docker'
import {
  helperRemovePaths,
  helperStatus,
  helperTrashPaths,
  isHelperReady
} from './privilegedHelper'

const SIP_PROTECTED_HINT =
  'Protected by macOS at the system level (likely a sealed Xcode Simulator runtime) — ' +
  'no app can remove this directly, even with admin rights. Reinstall Xcode and remove it ' +
  'via Xcode > Settings > Platforms, or `xcrun simctl runtime delete`.'

async function isParentWritable(targetPath: string): Promise<boolean> {
  try {
    await access(dirname(targetPath), constants.W_OK)
    return true
  } catch {
    return false
  }
}

function describeFsFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/operation not permitted/i.test(message)) return SIP_PROTECTED_HINT
  return message || 'Could not delete item'
}

async function removeAsUser(targetPath: string): Promise<void> {
  await rm(targetPath, { recursive: true, force: true })
}

/**
 * Prefer Trash when possible; fall back to a permanent user-level remove when the parent
 * directory is writable (covers /Applications for admin users without a password). Root-only
 * parents go through the privileged helper once it is registered.
 */
async function deletePath(
  targetPath: string,
  preferRemove: boolean
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!preferRemove) {
    try {
      await shell.trashItem(targetPath)
      return { ok: true }
    } catch {
      // Fall through — Trash often fails on root-owned files even when the parent is writable.
    }
  }

  if (await isParentWritable(targetPath)) {
    try {
      await removeAsUser(targetPath)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: describeFsFailure(err) }
    }
  }

  if (await isHelperReady()) {
    try {
      const errors = preferRemove
        ? await helperRemovePaths([targetPath])
        : await helperTrashPaths([targetPath])
      const error = errors.get(targetPath)
      if (!error) return { ok: true }
      return { ok: false, error: /operation not permitted/i.test(error) ? SIP_PROTECTED_HINT : error }
    } catch (err) {
      return { ok: false, error: describeFsFailure(err) }
    }
  }

  // Unpackaged Electron cannot register SMAppService; surface a clear need-helper signal
  // so the UI can offer install when the ctl exists, or explain the limitation in dev.
  const status = await helperStatus()
  if (status.ctlAvailable && status.status !== 'enabled') {
    return { ok: false, error: HELPER_REQUIRED }
  }

  if (!app.isPackaged) {
    return {
      ok: false,
      error:
        'This path needs the privileged helper, which only installs from a signed Bytemap.app. ' +
        'Build with `npm run build:mac` (or delete something under your home folder / Applications).'
    }
  }

  return { ok: false, error: HELPER_REQUIRED }
}

export async function performDeletions(
  items: { id: string; path: string; action?: ScanItemAction }[]
): Promise<DeleteResult[]> {
  const results: DeleteResult[] = []

  const helperTrashBatch: typeof items = []
  const helperRemoveBatch: typeof items = []

  for (const item of items) {
    if (item.action?.kind === 'dockerPrune') {
      try {
        await runDockerPrune(item.action.target)
        results.push({ id: item.id, path: item.path, ok: true })
      } catch (err) {
        results.push({ id: item.id, path: item.path, ok: false, error: (err as Error).message })
      }
      continue
    }

    const preferRemove = item.action?.kind === 'remove'
    const outcome = await deletePath(item.path, preferRemove)

    if (outcome.ok) {
      results.push({ id: item.id, path: item.path, ok: true })
      continue
    }

    // Group HELPER_REQUIRED items so one status check / later retry stays coherent.
    if (outcome.error === HELPER_REQUIRED) {
      if (preferRemove) helperRemoveBatch.push(item)
      else helperTrashBatch.push(item)
      continue
    }

    results.push({ id: item.id, path: item.path, ok: false, error: outcome.error })
  }

  // If the helper became available mid-batch (unlikely) or items were merely queued for
  // the UI install prompt, mark them HELPER_REQUIRED without re-trying here.
  for (const item of [...helperTrashBatch, ...helperRemoveBatch]) {
    results.push({ id: item.id, path: item.path, ok: false, error: HELPER_REQUIRED })
  }

  return results
}

/** Retry paths that previously returned HELPER_REQUIRED after the helper was installed. */
export async function performHelperDeletions(
  items: { id: string; path: string; action?: ScanItemAction }[]
): Promise<DeleteResult[]> {
  const results: DeleteResult[] = []
  if (!(await isHelperReady())) {
    for (const item of items) {
      results.push({ id: item.id, path: item.path, ok: false, error: HELPER_REQUIRED })
    }
    return results
  }

  const trashItems = items.filter((i) => i.action?.kind !== 'remove')
  const removeItems = items.filter((i) => i.action?.kind === 'remove')

  if (trashItems.length > 0) {
    try {
      const errors = await helperTrashPaths(trashItems.map((i) => i.path))
      for (const item of trashItems) {
        const error = errors.get(item.path)
        results.push({
          id: item.id,
          path: item.path,
          ok: !error,
          error: error
            ? /operation not permitted/i.test(error)
              ? SIP_PROTECTED_HINT
              : error
            : undefined
        })
      }
    } catch (err) {
      const message = describeFsFailure(err)
      for (const item of trashItems) {
        results.push({ id: item.id, path: item.path, ok: false, error: message })
      }
    }
  }

  if (removeItems.length > 0) {
    try {
      const errors = await helperRemovePaths(removeItems.map((i) => i.path))
      for (const item of removeItems) {
        const error = errors.get(item.path)
        results.push({
          id: item.id,
          path: item.path,
          ok: !error,
          error: error
            ? /operation not permitted/i.test(error)
              ? SIP_PROTECTED_HINT
              : error
            : undefined
        })
      }
    } catch (err) {
      const message = describeFsFailure(err)
      for (const item of removeItems) {
        results.push({ id: item.id, path: item.path, ok: false, error: message })
      }
    }
  }

  return results
}
