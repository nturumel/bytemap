import { app } from 'electron'
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { promisify } from 'util'
import type { PrivilegedHelperState, PrivilegedHelperStatus } from '@shared/types'

const execFileAsync = promisify(execFile)

const HELPER_LABEL = 'com.niharturumella.bytemap.helper'

function ctlPath(): string | null {
  const candidates = [
    // Packaged: Contents/MacOS/BytemapHelperCtl
    join(process.resourcesPath, '..', 'MacOS', 'BytemapHelperCtl'),
    join(app.getAppPath(), '..', '..', 'MacOS', 'BytemapHelperCtl'),
    // Dev: built into helper/.build
    join(app.getAppPath(), 'helper', '.build', 'release', 'BytemapHelperCtl'),
    join(process.cwd(), 'helper', '.build', 'release', 'BytemapHelperCtl'),
    join(process.cwd(), 'helper', '.build', 'debug', 'BytemapHelperCtl')
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function appBundlePath(): string {
  // process.execPath → …/Bytemap.app/Contents/MacOS/Bytemap
  return join(dirname(process.execPath), '..', '..')
}

function helperPlistPath(): string {
  return join(appBundlePath(), 'Contents', 'Library', 'LaunchDaemons', `${HELPER_LABEL}.plist`)
}

/**
 * SMAppService.daemon(plistName:) only works from a properly signed app bundle
 * (Developer ID / Apple Development with a Team ID). Ad-hoc / linker-signed builds
 * ship the plist at the right path but macOS returns "Unable to read plist".
 */
async function isSmapServiceEligible(): Promise<boolean> {
  if (!app.isPackaged || process.platform !== 'darwin') return false
  if (!existsSync(helperPlistPath())) return false
  try {
    const { stdout, stderr } = await execFileAsync(
      'codesign',
      ['-dv', '--verbose=4', appBundlePath()],
      { timeout: 15_000 }
    )
    const out = `${stdout}\n${stderr}`
    if (/Signature=adhoc/i.test(out)) return false
    if (/TeamIdentifier=not set/i.test(out)) return false
    if (!/TeamIdentifier=[A-Z0-9]+/i.test(out)) return false
    return true
  } catch {
    return false
  }
}

async function runCtl(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const ctl = ctlPath()
  if (!ctl) {
    return { stdout: '', stderr: 'BytemapHelperCtl not found', code: 127 }
  }
  try {
    const { stdout, stderr } = await execFileAsync(ctl, args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000
    })
    return { stdout: stdout.trim(), stderr: stderr.trim(), code: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string }
    return {
      stdout: (e.stdout ?? '').toString().trim(),
      stderr: (e.stderr ?? e.message ?? '').toString().trim(),
      code: typeof e.code === 'number' ? e.code : 1
    }
  }
}

function parseStatus(raw: string): PrivilegedHelperStatus {
  const value = raw.trim().toLowerCase()
  if (value === 'enabled') return 'enabled'
  if (value === 'requiresapproval' || value === 'requires_approval') return 'requiresApproval'
  if (value === 'notregistered' || value === 'not_registered') return 'notRegistered'
  return 'unavailable'
}

export async function helperStatus(): Promise<PrivilegedHelperState> {
  const ctl = ctlPath()
  const canRegister = await isSmapServiceEligible()
  if (!ctl) {
    return { status: 'unavailable', ctlAvailable: false, canRegister: false }
  }
  // Outside a Developer-signed .app, SMAppService cannot load the helper plist.
  if (!canRegister) {
    return { status: 'unavailable', ctlAvailable: true, canRegister: false }
  }
  const { stdout, code } = await runCtl(['status'])
  if (code !== 0) {
    return { status: 'unavailable', ctlAvailable: true, canRegister }
  }
  return { status: parseStatus(stdout), ctlAvailable: true, canRegister }
}

export async function isHelperReady(): Promise<boolean> {
  const state = await helperStatus()
  return state.status === 'enabled'
}

/** Triggers the one-time SMAppService registration (system auth dialog). */
export async function registerHelper(): Promise<PrivilegedHelperState> {
  if (!(await isSmapServiceEligible())) {
    throw new Error(
      'The protected-file helper needs a Developer ID–signed Bytemap.app. This build is not signed for SMAppService — protected deletes will use a one-time admin password prompt instead.'
    )
  }
  const { stdout, stderr, code } = await runCtl(['register'])
  if (code !== 0) {
    const detail = stderr || stdout || 'Failed to register privileged helper'
    if (/unable to read plist|codesign|signing|-67028/i.test(detail)) {
      throw new Error(
        'Helper install needs a properly signed Bytemap.app (Developer ID). macOS could not load the helper plist from this unsigned/ad-hoc build.'
      )
    }
    throw new Error(detail)
  }
  if (stdout) {
    return { status: parseStatus(stdout), ctlAvailable: true, canRegister: true }
  }
  return helperStatus()
}

function parsePathResults(stdout: string, paths: string[]): Map<string, string | null> {
  const outcome = new Map<string, string | null>()
  for (const p of paths) outcome.set(p, 'Unknown error')
  for (const line of stdout.split('\n')) {
    const ok = line.match(/^OK:(.+)$/)
    if (ok) {
      outcome.set(ok[1], null)
      continue
    }
    const fail = line.match(/^FAIL:(.+?):(.*)$/)
    if (fail) outcome.set(fail[1], fail[2] || 'Failed')
  }
  return outcome
}

/** path → error message; omitted/null error means success. Returns map of path → error | undefined for failures only in actions — we return full Map path→error|null. */
export async function helperTrashPaths(paths: string[]): Promise<Map<string, string | null>> {
  if (paths.length === 0) return new Map()
  const { stdout, stderr, code } = await runCtl(['trash', ...paths])
  if (code !== 0 && !stdout.includes('OK:') && !stdout.includes('FAIL:')) {
    throw new Error(stderr || `helper trash failed (${code})`)
  }
  return parsePathResults(stdout, paths)
}

export async function helperRemovePaths(paths: string[]): Promise<Map<string, string | null>> {
  if (paths.length === 0) return new Map()
  const { stdout, stderr, code } = await runCtl(['remove', ...paths])
  if (code !== 0 && !stdout.includes('OK:') && !stdout.includes('FAIL:')) {
    throw new Error(stderr || `helper remove failed (${code})`)
  }
  return parsePathResults(stdout, paths)
}

export { HELPER_LABEL, ctlPath }
