import { shell } from 'electron'
import { execFile } from 'child_process'
import { access, constants, existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs'
import { rm } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { homedir, tmpdir } from 'os'
import { promisify } from 'util'
import type { DeleteResult, ScanItemAction } from '@shared/types'
import { HELPER_REQUIRED } from '@shared/types'
import { runDockerPrune } from './scanners/docker'
import {
  helperRemovePaths,
  helperStatus,
  helperTrashPaths,
  isHelperReady
} from './privilegedHelper'

const execFileAsync = promisify(execFile)
const accessAsync = promisify(access)

const SIP_PROTECTED_HINT =
  'Protected by macOS at the system level (likely a sealed Xcode Simulator runtime) — ' +
  'no app can remove this directly, even with admin rights. Reinstall Xcode and remove it ' +
  'via Xcode > Settings > Platforms, or `xcrun simctl runtime delete`.'

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function uniqueTrashDestination(trashDir: string, name: string): string {
  let candidate = join(trashDir, name)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 1; existsSync(candidate); n++) {
    candidate = join(trashDir, `${stem} ${n}${ext}`)
  }
  return candidate
}

function describeElevatedFailure(stderr: string): string {
  if (/operation not permitted/i.test(stderr)) return SIP_PROTECTED_HINT
  return stderr.trim() || 'Could not delete even with admin privileges'
}

function describeFsFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/operation not permitted/i.test(message)) return SIP_PROTECTED_HINT
  return message || 'Could not delete item'
}

function isPermissionError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code
  if (code === 'EACCES' || code === 'EPERM') return true
  const message = err instanceof Error ? err.message : String(err)
  return /permission denied|operation not permitted|eacces|eperm/i.test(message)
}

async function isParentWritable(targetPath: string): Promise<boolean> {
  try {
    await accessAsync(dirname(targetPath), constants.W_OK)
    return true
  } catch {
    return false
  }
}

function isSealedSimulatorRuntime(path: string): boolean {
  const lower = path.toLowerCase()
  if (path.includes('/CoreSimulator/Images/') && lower.endsWith('.dmg')) return true
  if (path.includes('/CoreSimulator/Cryptex/')) return true
  if (path.includes('/CoreSimulator/Images/SimRuntimeBundle-')) return true
  return false
}

/**
 * One-shot admin password for the batch via osascript.
 * Used in development and for packaged builds that cannot register SMAppService
 * (ad-hoc / unsigned apps). Runs a temp shell script (avoids AppleScript quoting
 * footguns) and prefers Trash, falling back to rm -rf when mv into Trash fails.
 */
async function elevateBatch(
  ops: { path: string; preferRemove: boolean }[]
): Promise<Map<string, string | null>> {
  const trashDir = join(homedir(), '.Trash')
  mkdirSync(trashDir, { recursive: true })

  const lines: string[] = ['#!/bin/bash', 'set +e']
  ops.forEach((op, i) => {
    if (op.preferRemove) {
      lines.push(`ERR=$(rm -rf ${shellQuote(op.path)} 2>&1)`)
      lines.push(`if [ $? -eq 0 ]; then echo "OK:${i}"; else echo "FAIL:${i}:$ERR"; fi`)
      return
    }
    const dest = uniqueTrashDestination(trashDir, basename(op.path))
    lines.push(`ERR=$(mv ${shellQuote(op.path)} ${shellQuote(dest)} 2>&1)`)
    lines.push(`if [ $? -eq 0 ]; then echo "OK:${i}"`)
    lines.push(`else`)
    // Trash move often fails as root on xattrs — permanent remove is the reliable fallback.
    lines.push(`  ERR2=$(rm -rf ${shellQuote(op.path)} 2>&1)`)
    lines.push(
      `  if [ $? -eq 0 ]; then echo "OK:${i}"; else echo "FAIL:${i}:$ERR /$ERR2"; fi`
    )
    lines.push(`fi`)
  })

  const dir = mkdtempSync(join(tmpdir(), 'bytemap-elevate-'))
  const scriptPath = join(dir, 'run.sh')
  writeFileSync(scriptPath, lines.join('\n'), { mode: 0o755 })

  try {
    const escapedPath = scriptPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const { stdout } = await execFileAsync('osascript', [
      '-e',
      `do shell script "bash ${escapedPath}" with administrator privileges`
    ])
    console.log('[delete] elevate stdout:', stdout)

    const outcome = new Map<string, string | null>()
    for (const line of stdout.split('\n')) {
      const ok = line.match(/^OK:(\d+)$/)
      if (ok) {
        outcome.set(ops[Number(ok[1])].path, null)
        continue
      }
      const fail = line.match(/^FAIL:(\d+):(.*)$/)
      if (fail) outcome.set(ops[Number(fail[1])].path, describeElevatedFailure(fail[2]))
    }
    for (const op of ops) {
      if (!outcome.has(op.path)) outcome.set(op.path, 'Unknown elevated delete failure')
    }
    return outcome
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore cleanup
    }
  }
}

type DeleteItem = { id: string; path: string; action?: ScanItemAction }

async function tryUserDelete(
  targetPath: string,
  preferRemove: boolean
): Promise<'ok' | 'needsPrivilege' | { error: string }> {
  if (isSealedSimulatorRuntime(targetPath)) {
    return { error: SIP_PROTECTED_HINT }
  }

  if (!preferRemove) {
    try {
      await shell.trashItem(targetPath)
      return 'ok'
    } catch {
      // Fall through — Trash often fails on root-owned files even when the parent is writable.
    }
  }

  if (await isParentWritable(targetPath)) {
    try {
      await rm(targetPath, { recursive: true, force: true })
      return 'ok'
    } catch (err) {
      // Parent writable but delete still denied (restricted apps / SIP bits) → elevate.
      if (isPermissionError(err)) return 'needsPrivilege'
      return { error: describeFsFailure(err) }
    }
  }

  return 'needsPrivilege'
}

async function applyPrivilegeMap(
  items: DeleteItem[],
  outcome: Map<string, string | null>
): Promise<DeleteResult[]> {
  return items.map((item) => {
    const error = outcome.has(item.path) ? outcome.get(item.path) : 'Unknown error'
    return {
      id: item.id,
      path: item.path,
      ok: error === null,
      error: error ?? undefined
    }
  })
}

export async function performDeletions(items: DeleteItem[]): Promise<DeleteResult[]> {
  const results: DeleteResult[] = []
  const needsPrivilege: DeleteItem[] = []

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
    const outcome = await tryUserDelete(item.path, preferRemove)
    if (outcome === 'ok') {
      results.push({ id: item.id, path: item.path, ok: true })
    } else if (outcome === 'needsPrivilege') {
      needsPrivilege.push(item)
    } else {
      results.push({ id: item.id, path: item.path, ok: false, error: outcome.error })
    }
  }

  if (needsPrivilege.length === 0) return results
  console.log(
    `[delete] ${needsPrivilege.length} item(s) need privilege:`,
    needsPrivilege.map((i) => i.path)
  )

  if (await isHelperReady()) {
    const trashItems = needsPrivilege.filter((i) => i.action?.kind !== 'remove')
    const removeItems = needsPrivilege.filter((i) => i.action?.kind === 'remove')
    if (trashItems.length > 0) {
      try {
        results.push(
          ...(await applyPrivilegeMap(trashItems, await helperTrashPaths(trashItems.map((i) => i.path))))
        )
      } catch (err) {
        const message = describeFsFailure(err)
        for (const item of trashItems) {
          results.push({ id: item.id, path: item.path, ok: false, error: message })
        }
      }
    }
    if (removeItems.length > 0) {
      try {
        results.push(
          ...(await applyPrivilegeMap(removeItems, await helperRemovePaths(removeItems.map((i) => i.path))))
        )
      } catch (err) {
        const message = describeFsFailure(err)
        for (const item of removeItems) {
          results.push({ id: item.id, path: item.path, ok: false, error: message })
        }
      }
    }
    return results
  }

  const status = await helperStatus()
  // Properly signed builds can install the SMAppService helper once — defer to the UI.
  if (status.canRegister) {
    for (const item of needsPrivilege) {
      results.push({ id: item.id, path: item.path, ok: false, error: HELPER_REQUIRED })
    }
    return results
  }

  // Dev / unsigned packaged: one osascript auth for the batch (helper registration impossible).
  try {
    console.log(
      `[delete] elevating ${needsPrivilege.length} path(s) via admin prompt (helper cannot register)`
    )
    const ops = needsPrivilege.map((item) => ({
      path: item.path,
      preferRemove: item.action?.kind === 'remove'
    }))
    results.push(...(await applyPrivilegeMap(needsPrivilege, await elevateBatch(ops))))
  } catch (err) {
    console.error('[delete] elevate failed:', err)
    const message =
      err instanceof Error && /user canceled|cancelled/i.test(err.message)
        ? 'Admin authorization was cancelled'
        : describeFsFailure(err)
    for (const item of needsPrivilege) {
      results.push({ id: item.id, path: item.path, ok: false, error: message })
    }
  }
  return results
}

/** Retry paths that previously returned HELPER_REQUIRED after the helper was installed. */
export async function performHelperDeletions(items: DeleteItem[]): Promise<DeleteResult[]> {
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
      results.push(
        ...(await applyPrivilegeMap(trashItems, await helperTrashPaths(trashItems.map((i) => i.path))))
      )
    } catch (err) {
      const message = describeFsFailure(err)
      for (const item of trashItems) {
        results.push({ id: item.id, path: item.path, ok: false, error: message })
      }
    }
  }

  if (removeItems.length > 0) {
    try {
      results.push(
        ...(await applyPrivilegeMap(removeItems, await helperRemovePaths(removeItems.map((i) => i.path))))
      )
    } catch (err) {
      const message = describeFsFailure(err)
      for (const item of removeItems) {
        results.push({ id: item.id, path: item.path, ok: false, error: message })
      }
    }
  }

  return results
}
