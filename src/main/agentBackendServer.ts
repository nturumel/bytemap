import * as grpc from '@grpc/grpc-js'
import { loadAgentGrpcPackage } from './agentGrpcProtocol'
import type {
  BytemapAgentEvent,
  BytemapAgentRequest,
  BytemapAgentResponse,
  OmpProviderSnapshot,
  PrivilegedHelperState
} from '@shared/types'
import { BytemapAgentRuntime } from './bytemapAgent'
import { OmpBackendProviderAuthManager } from './ompBackendProviderAuth'

type JsonMessage = { payloadJson?: string }
type ProviderRequest = { providerId?: string }
type ApiKeyRequest = { providerId?: string; apiKey?: string }
type ModelRequest = { modelId?: string }
type SessionRequest = { sessionId?: string }
type CancelRequest = { requestId?: string; sessionId?: string }
type BackendEventMessage = { kind: string; payloadJson: string }
type UnaryCallback<T> = (error: grpc.ServiceError | null, value?: T) => void

type AskEnvelope = {
  request: BytemapAgentRequest
  helperCtlPath: string | null
  helperState: PrivilegedHelperState
  fullDiskAccess: boolean
}

const providers = new OmpBackendProviderAuthManager()
let currentHelperCtlPath: string | null = null
let currentHelperState: PrivilegedHelperState = {
  status: 'unavailable',
  ctlAvailable: false,
  canRegister: false
}
let currentFullDiskAccess = false

const runtime = new BytemapAgentRuntime({
  providers,
  helperCtlPath: () => currentHelperCtlPath,
  helperStatus: async () => currentHelperState,
  refreshFullDiskAccess: async () => currentFullDiskAccess,
  sendEvent: (event) =>
    pendingStreams.get(event.requestId)?.write(eventMessage('agent_event', event))
})

const pendingStreams = new Map<
  string,
  grpc.ServerWritableStream<JsonMessage, BackendEventMessage>
>()

async function main(): Promise<void> {
  const packageDefinition = loadAgentGrpcPackage()
  const server = new grpc.Server()
  server.addService(
    packageDefinition.bytemap.agent.v1.AgentBackend.service,
    serviceImplementation(server)
  )
  const ready = Promise.withResolvers<void>()
  server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, port) => {
    if (error) {
      ready.reject(error)
      return
    }
    server.start()
    if (typeof process.send === 'function') process.send({ type: 'ready', port })
    process.stdout.write(`BYTEMAP_AGENT_GRPC_READY ${port}\n`)
    ready.resolve()
  })
  await ready.promise
}

function serviceImplementation(server: grpc.Server): grpc.UntypedServiceImplementation {
  return {
    health: (
      _call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: UnaryCallback<{ ok: boolean; version: string }>
    ) => {
      callback(null, { ok: true, version: '1' })
    },
    providers: async (
      _call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: UnaryCallback<JsonMessage>
    ) => {
      unary(callback, async () => jsonMessage(await providers.providers()))
    },
    syncApiKeys: async (
      call: grpc.ServerUnaryCall<JsonMessage, unknown>,
      callback: UnaryCallback<JsonMessage>
    ) => {
      unary(callback, async () =>
        jsonMessage(
          await providers.syncApiKeys(parseJson<Record<string, string>>(call.request.payloadJson))
        )
      )
    },
    loginProvider: (call: grpc.ServerWritableStream<ProviderRequest, BackendEventMessage>) => {
      const providerId = requiredString(call.request.providerId, 'providerId')
      providers
        .loginProvider(providerId, (url) => call.write(eventMessage('auth_url', { url })))
        .then((snapshot) => {
          call.write(eventMessage('providers', snapshot))
          call.end()
        })
        .catch((error: unknown) => streamError(call, error))
    },
    setProviderApiKey: async (
      call: grpc.ServerUnaryCall<ApiKeyRequest, unknown>,
      callback: UnaryCallback<JsonMessage>
    ) => {
      unary(callback, async () =>
        jsonMessage(
          await providers.setProviderApiKey(
            requiredString(call.request.providerId, 'providerId'),
            requiredString(call.request.apiKey, 'apiKey')
          )
        )
      )
    },
    logoutProvider: async (
      call: grpc.ServerUnaryCall<ProviderRequest, unknown>,
      callback: UnaryCallback<JsonMessage>
    ) => {
      unary(callback, async () =>
        jsonMessage(
          await providers.logoutProvider(requiredString(call.request.providerId, 'providerId'))
        )
      )
    },
    selectModel: async (
      call: grpc.ServerUnaryCall<ModelRequest, unknown>,
      callback: UnaryCallback<Record<string, never>>
    ) => {
      unary(callback, async () => {
        await providers.selectModel(requiredString(call.request.modelId, 'modelId'))
        await runtime.disposeAll()
        return {}
      })
    },
    ask: (call: grpc.ServerWritableStream<JsonMessage, BackendEventMessage>) => {
      const envelope = parseJson<AskEnvelope>(call.request.payloadJson)
      currentHelperCtlPath = envelope.helperCtlPath
      currentHelperState = envelope.helperState
      currentFullDiskAccess = envelope.fullDiskAccess
      pendingStreams.set(envelope.request.requestId, call)
      runtime
        .ask(envelope.request)
        .then((response) => {
          call.write(eventMessage('final', response))
          call.end()
        })
        .catch((error: unknown) => streamError(call, error))
        .finally(() => pendingStreams.delete(envelope.request.requestId))
    },
    reset: async (
      call: grpc.ServerUnaryCall<SessionRequest, unknown>,
      callback: UnaryCallback<Record<string, never>>
    ) => {
      unary(callback, async () => {
        await runtime.reset(requiredString(call.request.sessionId, 'sessionId'))
        return {}
      })
    },
    cancel: async (
      call: grpc.ServerUnaryCall<CancelRequest, unknown>,
      callback: UnaryCallback<{ ok: boolean; reason: string }>
    ) => {
      unary(callback, async () => {
        const result = await runtime.cancel(
          requiredString(call.request.requestId, 'requestId'),
          requiredString(call.request.sessionId, 'sessionId')
        )
        return { ok: result.ok, reason: result.reason ?? '' }
      })
    },
    shutdown: async (
      _call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: UnaryCallback<Record<string, never>>
    ) => {
      unary(callback, async () => {
        await runtime.disposeAll()
        server.tryShutdown(() => undefined)
        return {}
      })
    }
  }
}

function jsonMessage(value: unknown): JsonMessage {
  return { payloadJson: JSON.stringify(value) }
}

function eventMessage(kind: string, value: unknown): BackendEventMessage {
  return { kind, payloadJson: JSON.stringify(value) }
}

async function unary<T>(callback: UnaryCallback<T>, action: () => Promise<T>): Promise<void> {
  try {
    callback(null, await action())
  } catch (error) {
    callback(toServiceError(error))
  }
}

function streamError(
  call: grpc.ServerWritableStream<unknown, BackendEventMessage>,
  error: unknown
): void {
  call.destroy(toServiceError(error))
}

function toServiceError(error: unknown): grpc.ServiceError {
  const serviceError = new Error(errorMessage(error)) as grpc.ServiceError
  serviceError.code = grpc.status.UNKNOWN
  return serviceError
}

function parseJson<T>(payload: string | undefined): T {
  if (!payload) throw new Error('gRPC JSON payload is empty')
  return JSON.parse(payload) as T
}

function requiredString(value: string | undefined, field: string): string {
  if (!value) throw new Error(`${field} is required`)
  return value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

process.on('SIGTERM', () => {
  const forceExit = setTimeout(() => process.exit(0), 1_000)
  forceExit.unref()
  void runtime.disposeAll().finally(() => process.exit(0))
})

void main().catch((error: unknown) => {
  process.stderr.write(`Bytemap agent backend failed: ${errorMessage(error)}\n`)
  process.exit(1)
})

export type {
  AskEnvelope,
  BackendEventMessage,
  OmpProviderSnapshot,
  BytemapAgentEvent,
  BytemapAgentResponse
}
