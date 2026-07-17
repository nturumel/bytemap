import { mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { join } from 'path'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'

export const AGENT_GRPC_PROTO = `syntax = "proto3";

package bytemap.agent.v1;

service AgentBackend {
  rpc Health(Empty) returns (HealthResponse);
  rpc Providers(Empty) returns (ProviderSnapshot);
  rpc SyncApiKeys(SyncApiKeysRequest) returns (ProviderSnapshot);
  rpc LoginProvider(ProviderRequest) returns (stream BackendEvent);
  rpc SetProviderApiKey(ApiKeyRequest) returns (ProviderSnapshot);
  rpc LogoutProvider(ProviderRequest) returns (ProviderSnapshot);
  rpc SelectModel(ModelRequest) returns (Empty);
  rpc Ask(AskRequest) returns (stream BackendEvent);
  rpc Reset(SessionRequest) returns (Empty);
  rpc Cancel(CancelRequest) returns (CancelResponse);
  rpc Shutdown(Empty) returns (Empty);
}

message Empty {}

message HealthResponse {
  bool ok = 1;
  string version = 2;
}

message ProviderSnapshot {
  string payloadJson = 1;
}

message SyncApiKeysRequest {
  string payloadJson = 1;
}

message ProviderRequest {
  string providerId = 1;
}

message ApiKeyRequest {
  string providerId = 1;
  string apiKey = 2;
}

message ModelRequest {
  string modelId = 1;
}

message AskRequest {
  string payloadJson = 1;
}

message SessionRequest {
  string sessionId = 1;
}

message CancelRequest {
  string requestId = 1;
  string sessionId = 2;
}

message CancelResponse {
  bool ok = 1;
  string reason = 2;
}

message BackendEvent {
  string kind = 1;
  string payloadJson = 2;
}
`

export type AgentGrpcPackage = {
  bytemap: {
    agent: {
      v1: {
        AgentBackend: grpc.ServiceClientConstructor
      }
    }
  }
}

export function ensureAgentGrpcProtoFile(): string {
  const digest = createHash('sha256').update(AGENT_GRPC_PROTO).digest('hex').slice(0, 16)
  const dir = join(tmpdir(), 'bytemap-agent-grpc')
  const path = join(dir, `agent-${digest}.proto`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(path, AGENT_GRPC_PROTO, { mode: 0o600 })
  return path
}

export function loadAgentGrpcPackage(): AgentGrpcPackage {
  const definition = protoLoader.loadSync(ensureAgentGrpcProtoFile(), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
  })
  return grpc.loadPackageDefinition(definition) as unknown as AgentGrpcPackage
}
