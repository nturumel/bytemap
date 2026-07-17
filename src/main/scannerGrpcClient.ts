import { app } from 'electron'
import { spawn as spawnChild, type ChildProcess } from 'child_process'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import * as grpc from '@grpc/grpc-js'
import { loadScannerGrpcPackage } from './scannerGrpcProtocol'
import type { DiskNode } from '@shared/types'

type ScannerClient = grpc.Client & Record<string, (...args: unknown[]) => unknown>
type CancelResponse = { ok?: boolean; reason?: string }
type SizeResponse = { size?: NumericValue }
type DirSizesResponse = { entries?: { path?: string; size?: NumericValue }[] }
type ProgressMessage = { message?: string }
type FileMessage = { path?: string; size?: NumericValue; mtime_ms?: NumericValue }
type LargeFileEvent = { progress?: ProgressMessage; file?: FileMessage; complete?: Record<string, never> }
type DuplicateGroupMessage = { size?: NumericValue; keeper?: string; duplicates?: string[] }
type DuplicateEvent = {
  progress?: ProgressMessage
  group?: DuplicateGroupMessage
  complete?: Record<string, never>
}
type DirNodeMessage = {
  name?: string
  path?: string
  size?: NumericValue
  is_dir?: boolean
  children?: DirNodeMessage[]
  children_expanded?: boolean
}
type BreakdownEvent = { progress?: ProgressMessage; node?: DirNodeMessage; complete?: Record<string, never> }
type NumericValue = string | number | bigint | undefined

export interface ScannerFileEntry {
  path: string
  size: number
  mtimeMs: number
}

export interface ScannerDuplicateGroup {
  size: number
  keeper: string
  duplicates: string[]
}

export class ScannerGrpcRuntimeClient {
  private child: ChildProcess | null = null
  private client: ScannerClient | null = null
  private ready: Promise<ScannerClient> | null = null
  private readonly activeStreams = new Map<string, grpc.ClientReadableStream<unknown>>()

  async dirSize(path: string): Promise<number> {
    const client = await this.acquireClient()
    const response = await this.unary<SizeResponse>(client, 'dirSize', { path })
    return numberFromWire(response.size, 'dirSize.size')
  }

  async dirSizes(paths: string[]): Promise<number[]> {
    if (paths.length === 0) return []
    const client = await this.acquireClient()
    const response = await this.unary<DirSizesResponse>(client, 'dirSizes', { paths })
    const sizes = new Map((response.entries ?? []).map((entry) => [entry.path ?? '', entry.size]))
    return paths.map((path) => numberFromWire(sizes.get(path), `dirSizes[${path}]`))
  }

  async findLargeFiles(
    roots: string[],
    threshold: number,
    onProgress: (message: string) => void,
    requestId: string = randomUUID()
  ): Promise<ScannerFileEntry[]> {
    const client = await this.acquireClient()
    const files: ScannerFileEntry[] = []
    await this.consumeStream<LargeFileEvent>(
      client,
      'findLargeFiles',
      { request_id: requestId, roots, threshold: uint64FromNumber(threshold, 'threshold') },
      (event) => {
        if (event.progress?.message) onProgress(event.progress.message)
        if (event.file) files.push(fileFromWire(event.file))
      }
    )
    return files
  }

  async findDuplicates(
    roots: string[],
    minSize: number,
    cacheDbPath: string,
    onProgress: (message: string) => void,
    requestId: string = randomUUID()
  ): Promise<ScannerDuplicateGroup[]> {
    const client = await this.acquireClient()
    const groups: ScannerDuplicateGroup[] = []
    await this.consumeStream<DuplicateEvent>(
      client,
      'findDuplicates',
      {
        request_id: requestId,
        roots,
        min_size: uint64FromNumber(minSize, 'minSize'),
        cache_db_path: cacheDbPath
      },
      (event) => {
        if (event.progress?.message) onProgress(event.progress.message)
        if (event.group) groups.push(duplicateGroupFromWire(event.group))
      }
    )
    return groups
  }

  async dirBreakdownStream(
    path: string,
    maxDepth: number,
    onNode: (node: DiskNode) => void,
    requestId: string = randomUUID()
  ): Promise<void> {
    const client = await this.acquireClient()
    await this.consumeStream<BreakdownEvent>(
      client,
      'dirBreakdown',
      { request_id: requestId, path, max_depth: uint32FromNumber(maxDepth, 'maxDepth') },
      (event) => {
        if (event.node) onNode(diskNodeFromWire(event.node))
      }
    )
  }

  async cancel(requestId: string): Promise<{ ok: boolean; reason?: string }> {
    const stream = this.activeStreams.get(requestId)
    stream?.cancel()
    const client = this.client
    if (!client)
      return {
        ok: Boolean(stream),
        reason: stream ? 'cancelled locally' : 'operation not active'
      }
    try {
      const response = await this.unary<CancelResponse>(client, 'cancel', { request_id: requestId })
      return {
        ok: Boolean(stream) || Boolean(response.ok),
        reason: response.reason || (stream ? 'cancelled locally' : undefined)
      }
    } catch (error) {
      if (stream) return { ok: true, reason: 'cancelled locally' }
      throw error
    }
  }

  async disposeAll(): Promise<void> {
    const client = this.client
    const child = this.child
    for (const stream of this.activeStreams.values()) stream.cancel()
    this.activeStreams.clear()
    this.client = null
    this.ready = null
    this.child = null
    client?.close()
    if (child && child.exitCode === null && !child.killed) child.kill('SIGTERM')
  }

  private async acquireClient(): Promise<ScannerClient> {
    let firstError: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const client = await this.ensureClient()
        await this.unary<Record<string, never>>(client, 'health', {})
        return client
      } catch (error) {
        if (attempt === 1) throw firstError ?? error
        firstError = error
        await this.disposeAll()
      }
    }
    throw firstError
  }

  private async ensureClient(): Promise<ScannerClient> {
    if (this.client) return this.client
    if (!this.ready) {
      const ready = this.startBackend()
      this.ready = ready
      void ready.catch(() => {
        if (this.ready === ready) this.ready = null
      })
    }
    return this.ready
  }

  private async startBackend(): Promise<ScannerClient> {
    const executable = resolveScannerExecutable()
    const child = spawnChild(executable, [], {
      env: {
        ...process.env,
        BYTEMAP_USER_DATA: app.getPath('userData'),
        BYTEMAP_REAL_HOME: app.getPath('home')
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.child = child
    child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(`[scanner] ${chunk.toString()}`))
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[scanner] ${chunk.toString()}`))

    try {
      const port = await waitForScannerReady(child)
      const packageDefinition = loadScannerGrpcPackage()
      const Client = packageDefinition.bytemap.scanner.v1.ScannerBackend
      const client = new Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure(), {
        'grpc.max_receive_message_length': 128 * 1024 * 1024
      }) as ScannerClient
      await waitForClientReady(client)
      if (this.child !== child) {
        client.close()
        throw new Error('Scanner backend was disposed while starting')
      }
      this.client = client
      child.once('exit', () => {
        if (this.child !== child) return
        this.client?.close()
        this.client = null
        this.ready = null
        this.child = null
      })
      return client
    } catch (error) {
      if (this.child === child) this.child = null
      if (child.exitCode === null && !child.killed) child.kill('SIGTERM')
      throw error
    }
  }

  private consumeStream<T>(
    client: ScannerClient,
    method: string,
    payload: Record<string, unknown>,
    onEvent: (event: T) => void
  ): Promise<void> {
    const fn = client[method]
    if (typeof fn !== 'function') return Promise.reject(new Error(`Scanner method is unavailable: ${method}`))
    const stream = fn.call(client, payload) as grpc.ClientReadableStream<T>
    const requestId = typeof payload.request_id === 'string' ? payload.request_id : undefined
    if (requestId) this.activeStreams.set(requestId, stream as grpc.ClientReadableStream<unknown>)
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      if (requestId && this.activeStreams.get(requestId) === stream)
        this.activeStreams.delete(requestId)
      if (error) reject(error)
      else resolve()
    }
    stream.on('data', onEvent)
    stream.once('error', (error: grpc.ServiceError) => {
      if (error.code === grpc.status.CANCELLED) finish()
      else finish(error)
    })
    stream.once('end', () => finish())
    return promise
  }

  private unary<T>(
    client: ScannerClient,
    method: string,
    payload: Record<string, unknown>
  ): Promise<T> {
    const fn = client[method]
    if (typeof fn !== 'function') return Promise.reject(new Error(`Scanner method is unavailable: ${method}`))
    const { promise, resolve, reject } = Promise.withResolvers<T>()
    fn.call(client, payload, (error: grpc.ServiceError | null, value: T) => {
      if (error) reject(error)
      else resolve(value)
    })
    return promise
  }
}

function waitForScannerReady(child: ChildProcess): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>()
  let stdout = ''
  let settled = false
  const finish = (error?: Error, port?: number): void => {
    if (settled) return
    settled = true
    clearTimeout(timeout)
    child.stdout?.off('data', onStdout)
    child.off('exit', onExit)
    child.off('error', onError)
    if (error) reject(error)
    else resolve(port as number)
  }
  const onStdout = (chunk: Buffer): void => {
    stdout += chunk.toString()
    const match = stdout.match(/BYTEMAP_SCANNER_GRPC_READY\s+(\d+)/)
    if (match?.[1]) finish(undefined, Number(match[1]))
    else if (stdout.length > 4096) stdout = stdout.slice(-4096)
  }
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
    finish(
      new Error(
        `Scanner backend exited before ready: code=${code ?? 'null'} signal=${signal ?? 'null'}`
      )
    )
  const onError = (error: Error): void => finish(error)
  const timeout = setTimeout(() => finish(new Error('Scanner backend did not start within 10s')), 10_000)
  child.stdout?.on('data', onStdout)
  child.once('exit', onExit)
  child.once('error', onError)
  return promise
}

function waitForClientReady(client: ScannerClient): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  client.waitForReady(Date.now() + 10_000, (error) => (error ? reject(error) : resolve()))
  return promise
}

function resolveScannerExecutable(): string {
  const executable = process.platform === 'win32' ? 'bytemap-scanner.exe' : 'bytemap-scanner'
  if (app.isPackaged) return join(dirname(process.execPath), executable)
  return join(__dirname, '../../native/target/release', executable)
}

function uint64FromNumber(value: number, field: string): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${field} must be a safe unsigned integer`)
  return String(value)
}

function uint32FromNumber(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff)
    throw new RangeError(`${field} must be a uint32`)
  return value
}

function numberFromWire(value: NumericValue, field: string): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new RangeError(`${field} is not a safe integer`)
    return value
  }
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER))
      throw new RangeError(`${field} exceeds JavaScript's safe integer range`)
    return Number(value)
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    return numberFromWire(BigInt(value), field)
  }
  throw new TypeError(`${field} was not an integer`) 
}

function fileFromWire(file: FileMessage): ScannerFileEntry {
  if (!file.path) throw new Error('Scanner returned a file without a path')
  return {
    path: file.path,
    size: numberFromWire(file.size, 'file.size'),
    mtimeMs: numberFromWire(file.mtime_ms, 'file.mtime_ms')
  }
}

function duplicateGroupFromWire(group: DuplicateGroupMessage): ScannerDuplicateGroup {
  if (!group.keeper) throw new Error('Scanner returned a duplicate group without a keeper')
  return {
    size: numberFromWire(group.size, 'duplicateGroup.size'),
    keeper: group.keeper,
    duplicates: group.duplicates ?? []
  }
}

function diskNodeFromWire(node: DirNodeMessage): DiskNode {
  if (!node.name || !node.path) throw new Error('Scanner returned a directory node without a name or path')
  return {
    name: node.name,
    path: node.path,
    size: numberFromWire(node.size, 'dirNode.size'),
    isDir: Boolean(node.is_dir),
    ...(node.children_expanded ? { children: (node.children ?? []).map(diskNodeFromWire) } : {})
  }
}
