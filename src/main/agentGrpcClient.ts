import { app, shell } from 'electron'
import { spawn as spawnChild, type ChildProcess } from 'child_process'
import { dirname, join } from 'path'
import * as grpc from '@grpc/grpc-js'
import { loadAgentGrpcPackage } from './agentGrpcProtocol'
import { AgentCredentialStore } from './agentCredentialStore'
import type {
  BytemapAgentEvent,
  BytemapAgentRequest,
  BytemapAgentResponse,
  OmpProviderSnapshot,
  PrivilegedHelperState
} from '@shared/types'

type JsonMessage = { payloadJson?: string }
type BackendEventMessage = { kind?: string; payloadJson?: string }
type CancelResponse = { ok?: boolean; reason?: string }
type AgentClient = grpc.Client & Record<string, (...args: unknown[]) => unknown>

type AgentGrpcClientDeps = {
  helperCtlPath: () => string | null
  helperStatus: () => Promise<PrivilegedHelperState>
  refreshFullDiskAccess: () => Promise<boolean>
  sendEvent: (event: BytemapAgentEvent) => void
}

export class AgentGrpcRuntimeClient {
  private readonly credentials = new AgentCredentialStore()
  private child: ChildProcess | null = null
  private client: AgentClient | null = null
  private ready: Promise<AgentClient> | null = null

  constructor(private readonly deps: AgentGrpcClientDeps) {}

  async providers(): Promise<OmpProviderSnapshot> {
    return this.withBackendRestartRetry(async () => {
      const client = await this.ensureClient()
      return parseJsonMessage<OmpProviderSnapshot>(
        await this.unary<JsonMessage>(client, 'providers', {})
      )
    })
  }

  async loginProvider(providerId: string): Promise<OmpProviderSnapshot> {
    const client = await this.ensureClient()
    const { promise, resolve, reject } = Promise.withResolvers<OmpProviderSnapshot>()
    const stream = client.loginProvider({
      providerId
    }) as grpc.ClientReadableStream<BackendEventMessage>
    let snapshot: OmpProviderSnapshot | null = null
    stream.on('data', (message) => {
      const payload = parseEventPayload<unknown>(message)
      if (message.kind === 'auth_url') {
        const url = asRecord(payload).url
        if (typeof url === 'string') {
          void shell.openExternal(url).then(
            () => process.stdout.write('[agent-auth] Opened OAuth URL in default browser\n'),
            (error: unknown) => {
              stream.cancel()
              reject(
                new Error(
                  `Could not open the OAuth browser: ${
                    error instanceof Error ? error.message : String(error)
                  }`
                )
              )
            }
          )
        }
      } else if (message.kind === 'providers') {
        snapshot = payload as OmpProviderSnapshot
      }
    })
    stream.on('error', reject)
    stream.on('end', () => {
      if (snapshot) resolve(snapshot)
      else reject(new Error('Provider login ended without a provider snapshot'))
    })
    return promise
  }

  async setProviderApiKey(providerId: string, apiKey: string): Promise<OmpProviderSnapshot> {
    const client = await this.ensureClient()
    const snapshot = parseJsonMessage<OmpProviderSnapshot>(
      await this.unary<JsonMessage>(client, 'setProviderApiKey', { providerId, apiKey })
    )
    await this.credentials.writeApiKey(providerId, apiKey)
    await this.syncApiKeys(client)
    return snapshot
  }

  async logoutProvider(providerId: string): Promise<OmpProviderSnapshot> {
    const client = await this.ensureClient()
    await this.credentials.removeApiKey(providerId)
    return parseJsonMessage<OmpProviderSnapshot>(
      await this.unary<JsonMessage>(client, 'logoutProvider', { providerId })
    )
  }

  async selectModel(modelId: string): Promise<void> {
    const client = await this.ensureClient()
    await this.unary<Record<string, never>>(client, 'selectModel', { modelId })
  }

  async ask(request: BytemapAgentRequest): Promise<BytemapAgentResponse> {
    const client = await this.ensureClient()
    const payload = {
      request,
      helperCtlPath: this.deps.helperCtlPath(),
      helperState: await this.deps.helperStatus(),
      fullDiskAccess: await this.deps.refreshFullDiskAccess()
    }
    const { promise, resolve, reject } = Promise.withResolvers<BytemapAgentResponse>()
    const stream = client.ask({
      payloadJson: JSON.stringify(payload)
    }) as grpc.ClientReadableStream<BackendEventMessage>
    let response: BytemapAgentResponse | null = null
    stream.on('data', (message) => {
      const payload = parseEventPayload<unknown>(message)
      if (message.kind === 'agent_event') this.deps.sendEvent(payload as BytemapAgentEvent)
      if (message.kind === 'final') response = payload as BytemapAgentResponse
    })
    stream.on('error', reject)
    stream.on('end', () => {
      if (response) resolve(response)
      else reject(new Error('Agent response stream ended without a final response'))
    })
    return promise
  }

  async reset(sessionId: string): Promise<void> {
    const client = await this.ensureClient()
    await this.unary<Record<string, never>>(client, 'reset', { sessionId })
  }

  async cancel(requestId: string, sessionId: string): Promise<{ ok: boolean; reason?: string }> {
    const client = await this.ensureClient()
    const result = await this.unary<CancelResponse>(client, 'cancel', { requestId, sessionId })
    return { ok: Boolean(result.ok), reason: result.reason || undefined }
  }

  async disposeAll(): Promise<void> {
    const client = this.client
    const child = this.child
    this.client = null
    this.ready = null
    this.child = null

    client?.close()
    if (child && child.exitCode === null && !child.killed) child.kill('SIGTERM')
  }

  private async withBackendRestartRetry<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      await this.disposeAll()
      try {
        return await operation()
      } catch {
        throw error
      }
    }
  }

  private async ensureClient(): Promise<AgentClient> {
    if (this.client) return this.client
    if (!this.ready) this.ready = this.startBackend()
    return this.ready
  }

  private async startBackend(): Promise<AgentClient> {
    const backendPath = resolveBackendPath()
    const child = spawnChild(resolveBunExecutable(), [backendPath], {
      env: {
        ...process.env,
        BYTEMAP_USER_DATA: app.getPath('userData'),
        BYTEMAP_REAL_HOME: app.getPath('home')
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.child = child
    child.stdout?.on('data', (chunk: Buffer) =>
      process.stdout.write(`[agent-backend] ${chunk.toString()}`)
    )
    child.stderr?.on('data', (chunk: Buffer) =>
      process.stderr.write(`[agent-backend] ${chunk.toString()}`)
    )
    const port = await waitForBackendReady(child)
    const packageDefinition = loadAgentGrpcPackage()
    const Client = packageDefinition.bytemap.agent.v1.AgentBackend
    const client = new Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure()) as AgentClient
    const ready = Promise.withResolvers<void>()
    client.waitForReady(Date.now() + 10_000, (error) =>
      error ? ready.reject(error) : ready.resolve()
    )
    await ready.promise
    this.client = client
    await this.syncApiKeys(client)
    return client
  }

  private async syncApiKeys(client: AgentClient): Promise<OmpProviderSnapshot> {
    const apiKeys = await this.credentials.readApiKeys()
    return parseJsonMessage<OmpProviderSnapshot>(
      await this.unary<JsonMessage>(client, 'syncApiKeys', { payloadJson: JSON.stringify(apiKeys) })
    )
  }

  private unary<T>(
    client: AgentClient,
    method: string,
    payload: Record<string, unknown>
  ): Promise<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>()
    const fn = client[method]
    if (typeof fn !== 'function') {
      reject(new Error(`Agent backend method is unavailable: ${method}`))
      return promise
    }
    fn.call(client, payload, (error: grpc.ServiceError | null, value: T) => {
      if (error) reject(error)
      else resolve(value)
    })
    return promise
  }
}

function waitForBackendReady(child: ChildProcess): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>()
  const timeout = setTimeout(
    () => reject(new Error('Agent backend did not start within 10s')),
    10_000
  )
  child.stdout?.on('data', (chunk: Buffer) => {
    const match = chunk.toString().match(/BYTEMAP_AGENT_GRPC_READY\s+(\d+)/)
    if (match?.[1]) {
      clearTimeout(timeout)
      resolve(Number(match[1]))
    }
  })
  child.once('exit', (code, signal) => {
    clearTimeout(timeout)
    reject(
      new Error(
        `Agent backend exited before ready: code=${code ?? 'null'} signal=${signal ?? 'null'}`
      )
    )
  })
  child.once('error', (error) => {
    clearTimeout(timeout)
    reject(error)
  })
  return promise
}

function resolveBackendPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'app.asar.unpacked/out/agent-backend/agentBackendServer.mjs')
  }
  return join(__dirname, '../agent-backend/agentBackendServer.mjs')
}

function resolveBunExecutable(): string {
  if (app.isPackaged) return join(dirname(process.execPath), 'bun')
  return process.env.BYTEMAP_BUN_PATH || process.env.BUN_PATH || 'bun'
}
function parseJsonMessage<T>(message: JsonMessage): T {
  if (!message.payloadJson) throw new Error('Agent backend returned an empty payload')
  return JSON.parse(message.payloadJson) as T
}

function parseEventPayload<T>(message: BackendEventMessage): T {
  if (!message.payloadJson)
    throw new Error(`Agent backend event ${message.kind ?? 'unknown'} had no payload`)
  return JSON.parse(message.payloadJson) as T
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}
