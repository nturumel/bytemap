# ByteMap Rust gRPC Cutover Plan

## Requirements summary

- Replace the in-process N-API Rust scanner addon with a standalone Rust gRPC sidecar.
- Preserve renderer-facing Electron IPC and current scan/disk-map behavior.
- Preserve OMP/Bun agent gRPC behavior, CLI-shared OAuth, and the verified chat UI.
- Add real cancellation for long Rust operations instead of only dropping late renderer events.
- Ship the Rust scanner binary inside `Bytemap.app`; remove `.node` addon loading and packaging.
- Keep the Swift privileged helper on its existing SMAppService/XPC boundary. It is not Rust and has different privilege/lifecycle requirements.

## Architecture decision

```text
Renderer
  │ Electron IPC (unchanged trust boundary)
  ▼
Electron main — sole local-process supervisor
  ├── gRPC → Bun AgentBackend (OMP/auth/chat)
  └── gRPC → Rust ScannerBackend (sizes/scans/disk map)

Swift privileged helper remains SMAppService + XPC.
```

Electron main owns the Rust sidecar directly. This avoids a needless Electron → Bun → Rust hop, keeps scanner failure isolation independent from OMP, and matches the process supervision already implemented in `src/main/agentGrpcClient.ts:163-192`.

## Protocol

Create canonical `proto/bytemap.proto`, unpacked into the packaged app and compiled by Rust with `tonic-prost-build`.

`ScannerBackend` RPCs:

- `Health(Empty) -> HealthResponse`
- `DirSize(PathRequest) -> SizeResponse`
- `DirSizes(PathsRequest) -> DirSizesResponse`
- `FindLargeFiles(FindLargeFilesRequest) -> stream LargeFileEvent`
- `FindDuplicates(FindDuplicatesRequest) -> stream DuplicateEvent`
- `DirBreakdown(DirBreakdownRequest) -> stream BreakdownEvent`
- `Cancel(OperationRequest) -> CancelResponse`
- `Shutdown(Empty) -> Empty`

Long-running requests carry `request_id`. Streaming events use typed `oneof` payloads for progress, items/groups/nodes, completion, and structured error details. Do not use JSON envelopes for Rust scanner data.

Cancellation uses a server-side `CancellationToken` registry keyed by `request_id`. Walk/hash loops check the token at bounded intervals. Electron both cancels the gRPC call and invokes `Cancel` so `spawn_blocking`/Rayon work stops rather than merely becoming invisible.

## Implementation steps

1. **Canonical schema and code generation**
   - Add `proto/bytemap.proto` with the scanner service and existing shared health/operation messages.
   - Update `native/Cargo.toml` from `napi`/`napi-derive` to `tonic 0.14`, `tonic-prost 0.14`, `prost`, `tokio`, `tokio-stream`, and `tokio-util`; use `tonic-prost-build 0.14` plus vendored `protoc` in `native/build.rs`.
   - Acceptance: Rust generated types compile without a machine-level `protoc` dependency.

2. **Refactor scanner algorithms out of N-API exports**
   - Replace N-API wrappers in `native/src/lib.rs:39-205` with ordinary Rust request functions.
   - Preserve exclusions/opaque-bundle behavior from `native/src/walk.rs:25-212`, duplicate fingerprints from `native/src/hash.rs:5-27`, and SQLite `file_hashes` semantics from `native/src/cache.rs:8-47`.
   - Thread cancellation checks through directory walking, hashing, and breakdown traversal.
   - Acceptance: same input paths produce the same `FileEntry`, `DuplicateGroup`, and `DirNode` values; cancelled work returns `CANCELLED` promptly.

3. **Implement the Rust gRPC server**
   - Add `native/src/main.rs` and service modules implementing `ScannerBackend`.
   - Bind `127.0.0.1:0`, print `BYTEMAP_SCANNER_GRPC_READY <port>`, reject non-loopback exposure, and implement bounded SIGTERM/shutdown.
   - Preserve current completion-order streaming; renderer already sorts disk children.
   - Acceptance: health succeeds, each RPC works from a standalone client, and cancellation stops CPU/filesystem work.

4. **Electron scanner runtime client**
   - Add `src/main/scannerGrpcClient.ts` using `@grpc/grpc-js`/`@grpc/proto-loader` and the lifecycle/error handling pattern from `src/main/agentGrpcClient.ts:163-267`.
   - Resolve dev and packaged binaries separately, pass ByteMap `userData`, parse the readiness line, restart once on pre-request transport failure, and terminate the child immediately during app shutdown.
   - Acceptance: a killed scanner sidecar restarts on the next safe request; no orphan remains after app exit.

5. **Migrate scan and disk-map callers**
   - Replace `src/main/native.ts:1-80` addon calls with scanner gRPC client methods while retaining narrow TS wrappers where useful.
   - Update consumers in `src/main/scanners/utils.ts`, `largeFiles.ts`, `duplicates.ts`, `unusedApps.ts`, `caches.ts`, and `appLeftovers.ts` without changing their renderer-visible output.
   - Move `src/main/index.ts:120-139` disk breakdown to the gRPC stream and wire `disk:cancelBreakdown` to real cancellation.
   - Acceptance: `scan:start` still emits progress/items/category completion; disk-map supersession emits no stale nodes and stops the Rust request.

6. **Clean cutover and packaging**
   - Delete generated N-API loader/type/binary artifacts and remove `../../native` externalization from `electron.vite.config.ts:8-18`.
   - Replace root `build:native*` scripts with Rust sidecar build checks.
   - Update `electron-builder.yml:13-27,43-51` to ship `bytemap-scanner` in `Contents/MacOS` and unpack `proto/**`; remove native-addon unpack rules.
   - Acceptance: packaged app contains the scanner executable and no `.node` scanner addon or N-API runtime dependency.

7. **Behavior verification and final delivery**
   - Compare large-file, duplicate, directory-size, and disk-breakdown outputs against pre-cutover fixtures/known paths.
   - Exercise cancellation, sidecar crash/restart, app quit during a stream, packaged startup, OMP provider availability, Markdown/thinking chat, Enter send, and Shift+Enter newline.
   - Build/install `/Applications/Bytemap.app`, verify installed artifacts match the build, then commit and push the complete cutover.

## Acceptance criteria

- No production TypeScript imports or requires the N-API scanner.
- All Rust scanner operations cross a loopback gRPC boundary with typed protobuf messages.
- Cancelling a disk breakdown terminates Rust work, not only renderer updates.
- Existing scan categories and shared `DiskNode`/scan item shapes remain unchanged.
- Duplicate cache remains at ByteMap `scan-cache.db` with compatible `file_hashes` behavior.
- Packaged app launches both Bun and Rust sidecars, leaves no orphans, and works without Cargo/protoc installed.
- OMP Codex remains available from the CLI auth store; free-form chat does not start a cleanup scan.
- Markdown, thinking blocks, tool blocks, Enter send, and Shift+Enter newline remain verified.
- Typecheck, contract tests, Rust tests/checks, packaged smoke tests, installation, commit, and remote push all succeed.

## Risks and mitigations

- **Cancellation gaps inside blocking filesystem work:** propagate `CancellationToken` through walkers and hash loops; test with a large tree.
- **Protocol drift:** one checked-in `.proto` is the source of truth; Rust codegen and TS runtime loading consume the same file.
- **Ordering changes:** preserve completion-order events and existing renderer sorting.
- **Sidecar orphaning:** kill child before closing gRPC clients; Rust also has bounded signal shutdown.
- **Packaged path differences:** verify the exact installed binary/proto paths, not only development mode.
- **Cache regression:** retain SQLite schema and hashing thresholds exactly; compare warm and cold duplicate scans.

## Non-goals

- Replacing renderer ↔ Electron IPC with network gRPC.
- Replacing the Swift privileged helper's XPC control plane.
- Combining Bun and Rust into one process.
