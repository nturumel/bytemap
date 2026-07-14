import { watch, type FSWatcher } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import { homedir } from 'os'
import { app } from 'electron'

export interface DiskChangePayload {
  /** Watched root (absolute). */
  root: string
  /** Coalesced absolute paths that changed (files or dirs). */
  paths: string[]
  /** Immediate children of `root` affected (best-effort). */
  childNames: string[]
  /** Monotonic watcher generation for this root. */
  generation: number
  /** True when Bytemap recently called expectChanges for overlapping paths. */
  selfTriggered: boolean
}

type ChangeListener = (payload: DiskChangePayload) => void

/** Collapse FS event bursts before considering a flush. */
const DEBOUNCE_MS = 1_200
/** Floor between emitted change payloads for the same root (stops rescan churn). */
const MIN_EMIT_INTERVAL_MS = 6_000
/** After a breakdown ends, absorb residual FSEvents from the walk itself. */
const POST_BREAKDOWN_SETTLE_MS = 2_500
const EXPECT_TTL_MS = 8_000

interface RootWatch {
  root: string
  watcher: FSWatcher
  generation: number
  pending: Set<string>
  timer: ReturnType<typeof setTimeout> | null
  /** Serialize: ignore FS events that land while a breakdown of this root is loading. */
  breakdownActive: boolean
  /** Earliest wall time we may emit another payload for this root. */
  nextEmitAt: number
  /** Swallow non-expected events until this time (post-breakdown settle). */
  settleUntil: number
}

/**
 * Practical FS watcher for the visualized root (macOS FSEvents via fs.watch recursive).
 *
 * Race / lifecycle choices:
 * - Debounce+coalesce bursts so rapid writes collapse into one payload.
 * - Min emit interval per root so noisy trees (home, Library) cannot rescan-loop.
 * - Per-root `generation` increments on every flush — renderer should drop stale work.
 * - Global `breakdownDepth`: while any breakdown is in flight, events queue but do not
 *   flush (avoids aux-root Caches events kicking a home rescan mid-walk).
 * - Post-breakdown settle window absorbs walk-triggered FSEvents.
 * - High-churn prefixes under home (Caches, Logs, app userData, …) are ignored unless
 *   `expectChanges` covers them (intentional delete refresh).
 * - `expectChanges`: marks self-deletes so renderer refreshes intentionally.
 * - Scope: single recursive watch on the current root (+ optional auxiliaries not under
 *   that root), never `/`.
 */
export class DiskWatchService {
  private roots = new Map<string, RootWatch>()
  private listener: ChangeListener | null = null
  private expected = new Map<string, number>() // path → expiry ms
  /** Nested begin/end breakdown calls across roots. */
  private breakdownDepth = 0
  private quietPrefixes: string[] = []

  constructor() {
    this.refreshQuietPrefixes()
  }

  /** Recompute ignored prefixes (call once app is ready so userData is valid). */
  refreshQuietPrefixes(): void {
    const home = resolve(homedir())
    const prefixes = [
      join(home, 'Library', 'Caches'),
      join(home, 'Library', 'Logs'),
      join(home, 'Library', 'Logs', 'DiagnosticReports'),
      join(home, 'Library', 'Saved Application State'),
      join(home, '.Trash')
    ]
    try {
      prefixes.push(app.getPath('userData'))
      prefixes.push(app.getPath('temp'))
      prefixes.push(app.getPath('logs'))
      prefixes.push(app.getPath('sessionData'))
    } catch {
      // app may not be ready in unit-ish imports — home-relative defaults still apply.
      prefixes.push(join(home, 'Library', 'Application Support'))
    }
    this.quietPrefixes = prefixes.map((p) => resolve(p))
  }

  setListener(listener: ChangeListener | null): void {
    this.listener = listener
  }

  /** Tell the watcher Bytemap is about to trash/remove these paths. */
  expectChanges(paths: string[], ttlMs = EXPECT_TTL_MS): void {
    const until = Date.now() + ttlMs
    for (const p of paths) {
      this.expected.set(resolve(p), until)
    }
  }

  clearExpected(): void {
    this.expected.clear()
  }

  /** Keep exactly these roots watched (current visual path + optional auxiliaries). */
  setWatchedRoots(paths: string[]): void {
    const next = new Set(paths.filter(Boolean).map((p) => resolve(p)))
    for (const [root, state] of this.roots) {
      if (!next.has(root)) this.unwatch(root, state)
    }
    for (const root of next) {
      if (!this.roots.has(root)) this.watchRoot(root)
    }
  }

  /** Call when a breakdown for `root` starts — delays flush until finished. */
  beginBreakdown(root: string): void {
    this.breakdownDepth += 1
    const state = this.roots.get(resolve(root))
    if (state) state.breakdownActive = true
  }

  /** Call when breakdown completes or is cancelled for `root`. */
  endBreakdown(root: string): void {
    this.breakdownDepth = Math.max(0, this.breakdownDepth - 1)
    const state = this.roots.get(resolve(root))
    if (!state) {
      // Still may need to flush other roots once the global gate opens.
      if (this.breakdownDepth === 0) {
        for (const s of this.roots.values()) {
          if (s.pending.size > 0) this.scheduleFlush(s)
        }
      }
      return
    }
    state.breakdownActive = false
    // Drop noise from directory enumeration; keep expected (self-delete) paths.
    const keep = new Set<string>()
    for (const p of state.pending) {
      if (this.isExpected(p)) keep.add(p)
    }
    state.pending = keep
    state.settleUntil = Date.now() + POST_BREAKDOWN_SETTLE_MS
    if (this.breakdownDepth === 0 && state.pending.size > 0) {
      this.scheduleFlush(state)
    } else if (this.breakdownDepth === 0) {
      for (const s of this.roots.values()) {
        if (s.pending.size > 0) this.scheduleFlush(s)
      }
    }
  }

  stopAll(): void {
    for (const [root, state] of this.roots) this.unwatch(root, state)
    this.breakdownDepth = 0
  }

  private watchRoot(root: string): void {
    try {
      const watcher = watch(root, { recursive: true }, (_eventType, filename) => {
        const state = this.roots.get(root)
        if (!state) return
        const changed = filename ? resolve(root, filename.toString()) : root
        if (this.shouldIgnorePath(root, changed)) return
        state.pending.add(changed)
        if (!state.breakdownActive && this.breakdownDepth === 0) {
          this.scheduleFlush(state)
        }
      })
      watcher.on('error', () => {
        // Permission errors / deleted directory — drop this watch quietly.
        const state = this.roots.get(root)
        if (state) this.unwatch(root, state)
      })
      this.roots.set(root, {
        root,
        watcher,
        generation: 0,
        pending: new Set(),
        timer: null,
        breakdownActive: false,
        nextEmitAt: 0,
        settleUntil: 0
      })
    } catch {
      // Can't watch (missing path / permissions) — skip.
    }
  }

  private unwatch(root: string, state: RootWatch): void {
    if (state.timer) clearTimeout(state.timer)
    try {
      state.watcher.close()
    } catch {
      // ignore
    }
    this.roots.delete(root)
  }

  private scheduleFlush(state: RootWatch): void {
    if (state.timer) clearTimeout(state.timer)
    const now = Date.now()
    const settleWait = Math.max(0, state.settleUntil - now)
    const rateWait = Math.max(0, state.nextEmitAt - now)
    const delay = Math.max(DEBOUNCE_MS, settleWait, rateWait)
    state.timer = setTimeout(() => this.flush(state), delay)
  }

  private flush(state: RootWatch): void {
    state.timer = null
    if (state.breakdownActive || this.breakdownDepth > 0 || state.pending.size === 0) return

    const now = Date.now()
    for (const [p, until] of this.expected) {
      if (until <= now) this.expected.delete(p)
    }

    // During settle, only emit if the change was intentionally expected (deletes).
    if (now < state.settleUntil) {
      const expectedOnly = [...state.pending].filter((p) => this.isExpected(p))
      if (expectedOnly.length === 0) {
        // Keep absorbing; reschedule once settle ends.
        this.scheduleFlush(state)
        return
      }
      state.pending = new Set(expectedOnly)
    }

    if (now < state.nextEmitAt) {
      this.scheduleFlush(state)
      return
    }

    const paths = [...state.pending].filter(
      (p) => !this.shouldIgnorePath(state.root, p) || this.isExpected(p)
    )
    state.pending.clear()
    if (paths.length === 0) return

    state.generation += 1
    state.nextEmitAt = now + MIN_EMIT_INTERVAL_MS

    const selfTriggered = paths.some((p) => this.isExpected(p))
    const childNames = new Set<string>()
    for (const p of paths) {
      const rel = p.startsWith(state.root + '/') ? p.slice(state.root.length + 1) : ''
      const top = rel.split('/')[0]
      if (top) childNames.add(top)
      else if (p === state.root) childNames.add(basename(state.root))
    }

    this.listener?.({
      root: state.root,
      paths,
      childNames: [...childNames],
      generation: state.generation,
      selfTriggered
    })
  }

  /**
   * Drop high-churn subtrees when they appear as noise under a broader watch
   * (e.g. home → Library/Caches). When the watched root *is* that subtree,
   * surface events normally.
   */
  private shouldIgnorePath(watchRoot: string, path: string): boolean {
    const abs = resolve(path)
    const root = resolve(watchRoot)
    if (this.isExpected(abs)) return false
    for (const prefix of this.quietPrefixes) {
      if (abs !== prefix && !abs.startsWith(prefix + '/')) continue
      // Watching the quiet tree itself (or inside it) — keep events.
      if (root === prefix || root.startsWith(prefix + '/')) return false
      // Quiet tree is a strict descendant of this watch — treat as noise.
      if (prefix.startsWith(root + '/')) return true
    }
    return false
  }

  private isExpected(path: string): boolean {
    const abs = resolve(path)
    if (this.expected.has(abs)) return true
    for (const [expected] of this.expected) {
      if (abs === expected || abs.startsWith(expected + '/') || expected.startsWith(abs + '/')) {
        return true
      }
    }
    return false
  }
}

/** Well-known reclaimable roots worth watching even when not the visual focus. */
export function defaultCleanupWatchRoots(): string[] {
  const home = homedir()
  return [
    join(home, 'Library', 'Caches'),
    join(home, 'Library', 'Logs'),
    join(home, 'Library', 'Developer', 'Xcode', 'DerivedData'),
    join(home, 'Downloads'),
    join(home, '.cache'),
    join(home, '.npm', '_cacache')
  ].map((p) => resolve(p))
}

/**
 * Drop auxiliaries already covered by a recursive visual-root watch so the same
 * FSEvents are not observed (and coalesced/emitted) twice.
 */
export function auxiliariesOutsideRoot(visualRoot: string, auxiliaries: string[]): string[] {
  const root = resolve(visualRoot)
  return auxiliaries.filter((p) => {
    const abs = resolve(p)
    return abs !== root && !abs.startsWith(root + '/')
  })
}

/** Parent dir used for cache-key invalidation when a watched file changes. */
export function invalidateKeysForChange(root: string, changedPaths: string[]): string[] {
  const keys = new Set<string>([root])
  for (const p of changedPaths) {
    let cur = dirname(p)
    while (cur?.startsWith(root)) {
      keys.add(cur)
      if (cur === root) break
      const parent = dirname(cur)
      if (parent === cur) break
      cur = parent
    }
  }
  return [...keys]
}

export const diskWatchService = new DiskWatchService()
