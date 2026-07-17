import { app } from 'electron'
import { join } from 'path'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'

export type ScannerGrpcPackage = {
  bytemap: {
    scanner: {
      v1: {
        ScannerBackend: grpc.ServiceClientConstructor
      }
    }
  }
}

/** The checked-in schema is the sole wire contract shared with the scanner sidecar. */
export function scannerGrpcProtoPath(): string {
  if (app.isPackaged)
    return join(process.resourcesPath, 'app.asar.unpacked', 'proto', 'bytemap.proto')
  return join(__dirname, '../../proto/bytemap.proto')
}

export function loadScannerGrpcPackage(): ScannerGrpcPackage {
  const definition = protoLoader.loadSync(scannerGrpcProtoPath(), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
  })
  return grpc.loadPackageDefinition(definition) as unknown as ScannerGrpcPackage
}
