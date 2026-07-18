import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

const requiredSkills = [
  'bytemap-filesystem-operator',
  'bytemap-code-bulk-cleaner',
  'bytemap-cache-inspector',
  'bytemap-cleanup-advisor',
  'bytemap-disk-map-advisor',
  'bytemap-cloud-offload-advisor',
  'bytemap-deletion-policy',
  'bytemap-permission-recovery'
]

const requiredProviders = [
  'anthropic',
  'openai-codex',
  'openai',
  'google',
  'github-copilot',
  'cursor',
  'ollama',
  'lm-studio',
  'llama.cpp'
]

test('agent prompt exposes app-scoped OMP state and cache schemas', async () => {
  const prompt = await read('src/main/bytemapAgentPrompt.ts')
  for (const needle of [
    'omp-home',
    'realHome',
    'scan-cache.db',
    'disk-map-cache.db',
    'file_hashes',
    'disk_map_views',
    'disk_map_nodes',
    'helperCtl',
    'fullDiskAccess',
    'contextJson'
  ]) {
    assert.match(prompt, new RegExp(needle.replace('.', '\\.')))
  }
})

test('agent skills install every free-form Bytemap skill without restrictive advisor wording', async () => {
  const skills = await read('src/main/bytemapAgentSkills.ts')
  for (const skill of requiredSkills) assert.match(skills, new RegExp(skill))
  assert.doesNotMatch(
    skills,
    /Use only JSON metadata|Do not run shell commands|Do not delete files/
  )
  assert.match(skills, /Find, inspect, move, trash, or remove user-requested local paths/)
  assert.match(skills, /Before moving a project\/folder to cloud storage/)
})

test('provider backend exposes required OMP providers and encrypted API-key storage', async () => {
  const providerBackend = await read('src/main/ompBackendProviderAuth.ts')
  const credentialStore = await read('src/main/agentCredentialStore.ts')
  const grpcClient = await read('src/main/agentGrpcClient.ts')
  for (const provider of requiredProviders)
    assert.match(providerBackend, new RegExp(provider.replace('.', '\\.')))
  assert.match(credentialStore, /safeStorage\.encryptString/)
  assert.match(credentialStore, /provider-credentials\.json/)
  assert.match(providerBackend, /setRuntimeApiKey/)
  assert.match(providerBackend, /authStorage\.login|\.login\(providerId/)
  assert.match(providerBackend, /requiredEnv\('BYTEMAP_REAL_HOME'\)/)
  assert.match(providerBackend, /join\(this\.realHome,\s*'\.omp',\s*'agent'\)/)
  assert.match(providerBackend, /discoverAuthStorage\(this\.authAgentDir\)/)
  assert.match(grpcClient, /resolveBunExecutable/)
})

test('OAuth opens in the default browser and backend shutdown cannot hang', async () => {
  const providerBackend = await read('src/main/ompBackendProviderAuth.ts')
  const grpcClient = await read('src/main/agentGrpcClient.ts')
  const backendServer = await read('src/main/agentBackendServer.ts')

  assert.match(providerBackend, /onPrompt:\s*\(\)\s*=>\s*new Promise<string>/)
  assert.match(grpcClient, /shell\.openExternal\(url\)/)
  assert.match(grpcClient, /Opened OAuth URL in default browser/)
  assert.match(grpcClient, /child\.kill\('SIGTERM'\)/)
  assert.match(backendServer, /setTimeout\(\(\)\s*=>\s*process\.exit\(0\),\s*1_000\)/)
})

test('agent runtime uses OMP SDK without output schema or forced yield restriction', async () => {
  const runtime = await read('src/main/bytemapAgent.ts')
  assert.match(runtime, /@oh-my-pi\/pi-coding-agent/)
  assert.match(runtime, /createAgentSession/)
  assert.match(runtime, /SessionManager\.inMemory/)
  assert.match(runtime, /systemPrompt: BYTEMAP_AGENT_SYSTEM_PROMPT/)
  assert.match(runtime, /autoApprove: true/)
  assert.doesNotMatch(
    runtime,
    /outputSchema|requireYieldTool|setForcedToolChoice|toolNames:\s*\['yield'\]/
  )
  assert.doesNotMatch(runtime, /advisor\.enabled/)
})

test('renderer chat records tool activity and renders structured cleanup plans', async () => {
  const hook = await read('src/renderer/src/hooks/useBytemapAgentChat.ts')
  const widget = await read('src/renderer/src/components/AgentChatWidget.tsx')
  const cleanupPlan = await read('src/renderer/src/lib/agentCleanupPlan.ts')
  const prompt = await read('src/main/bytemapAgentPrompt.ts')
  const runtime = await read('src/main/bytemapAgent.ts')
  const toolDisplay = await read('src/shared/agentToolDisplay.ts')
  assert.match(hook, /tool_start/)
  assert.match(hook, /tool_end/)
  assert.match(hook, /argsText/)
  assert.match(hook, /toolCallId/)
  assert.match(hook, /window\.api\.agent\.reset/)
  assert.match(widget, /Terminal \+ cache access · cleans before cloud moves · reports changes/)
  assert.match(hook, /assistant_delta[\s\S]*status: undefined/)
  assert.match(widget, /message\.status && !message\.text/)
  assert.match(runtime, /thinking_delta/)
  assert.match(runtime, /mapOmpToolExecutionEvent/)
  assert.match(toolDisplay, /args\.command|command/)
  assert.match(toolDisplay, /partialResult/)
  assert.match(toolDisplay, /isError/)
  assert.match(hook, /thinking:\s*\(message\.thinking \?\? ''\) \+ event\.text/)
  assert.match(widget, /Streamdown/)
  assert.match(widget, /AgentActivityPanel/)
  assert.match(widget, /AgentCleanupPlan/)
  assert.match(widget, /showItemInFolder\(item\.path\)/)
  assert.match(widget, /argsText/)
  assert.match(widget, /Running…/)
  assert.match(widget, /agent-tool-scroll/)
  assert.match(cleanupPlan, /bytemap-cleanup-plan/)
  assert.match(cleanupPlan, /\['easy', 'optional', 'keep'\]/)
  assert.match(cleanupPlan, /\['trash', 'permanent', 'keep'\]/)
  assert.match(prompt, /Structured cleanup result contract/)
  assert.match(prompt, /Nothing may appear after its closing fence/)
  assert.match(prompt, /Never invent paths, sizes, reasons, categories/)
  assert.match(widget, /event\.key !== 'Enter'/)
  assert.match(widget, /event\.shiftKey/)
  assert.match(widget, /form\?\.requestSubmit\(\)/)
  assert.doesNotMatch(`${hook}\n${widget}`, /suggestedActions|dispatchAdvisorAction/)
  assert.doesNotMatch(widget, /Terminal command/)
})

test('intro chat stays free-form and never starts a cleanup scan', async () => {
  const app = await read('src/renderer/src/App.tsx')
  const context = await read('src/renderer/src/lib/agentContext.ts')
  const chat = await read('src/renderer/src/hooks/useBytemapAgentChat.ts')
  const diskUsage = await read('src/renderer/src/components/DiskUsageScreen.tsx')

  assert.match(context, /kind:\s*'freeChat',\s*phase:\s*'idle'/)
  assert.match(app, /scan\.phase === 'intro'\s*\?\s*buildFreeChatAgentContext\(\)/)
  assert.match(app, /<AgentChatWidget context=\{agentContext\}/)
  // Single App-level agent overlay — must not remount when entering Disk Usage.
  assert.match(app, /Always mounted so chat\/session survive/)
  assert.doesNotMatch(diskUsage, /<AgentChatWidget/)
  assert.doesNotMatch(chat, /scan:start|startScan/)
  assert.doesNotMatch(app, /useEffect[\s\S]*startScan/)
})

test('agent panel supports minimize without clearing the session', async () => {
  const widget = await read('src/renderer/src/components/AgentChatWidget.tsx')
  assert.match(widget, /Minimize/)
  assert.match(widget, /panelMode === 'minimized'/)
  assert.match(widget, /Bytemap agent/)
  assert.match(widget, /setPanelMode\('minimized'\)/)
  assert.match(widget, /setPanelMode\('closed'\)/)
  assert.match(widget, /Sign out/)
  assert.match(widget, /chat\.signOut/)
  assert.match(widget, /AgentLogoutIcon/)
})

test('agent sign-out clears active provider credentials and chat session', async () => {
  const hook = await read('src/renderer/src/hooks/useBytemapAgentChat.ts')
  const auth = await read('src/main/ompBackendProviderAuth.ts')
  const grpc = await read('src/main/agentGrpcClient.ts')
  assert.match(hook, /signOut/)
  assert.match(hook, /logoutProvider\(providerId\)/)
  assert.match(hook, /setMessages\(\[\]\)/)
  assert.match(hook, /window\.api\.agent\.reset/)
  assert.match(auth, /Skip auto-select so logout reliably returns/)
  assert.match(auth, /removeRuntimeApiKey|authStorage\(\)\.logout/)
  assert.match(grpc, /credentials\.removeApiKey/)
})

test('agent Stop cancels the in-flight turn without waiting for ask to finish', async () => {
  const hook = await read('src/renderer/src/hooks/useBytemapAgentChat.ts')
  const runtime = await read('src/main/bytemapAgent.ts')
  const preload = await read('src/preload/index.ts')
  const main = await read('src/main/index.ts')
  const widget = await read('src/renderer/src/components/AgentChatWidget.tsx')

  // Session id must exist before ask resolves so first-turn Stop is not a no-op.
  assert.match(hook, /sessionIdRef\.current \?\? crypto\.randomUUID\(\)/)
  assert.match(hook, /sessionId:\s*nextSessionId/)
  assert.match(hook, /stoppedRequestIdRef/)
  assert.match(hook, /window\.api\.agent\.cancel\(requestId,\s*sid\)/)
  assert.doesNotMatch(hook, /if\s*\(\s*!activeRequestId\s*\|\|\s*!sessionId\s*\)\s*return/)
  assert.match(runtime, /entry\.session\.abort\(/)
  assert.match(runtime, /activeRequestId === requestId/)
  assert.match(preload, /agent:cancel/)
  assert.match(main, /agent:cancel/)
  assert.match(widget, /chat\.stop\(\)/)
  assert.match(widget, /agent-stop-btn/)
})

test('Rust scanner uses a typed gRPC sidecar with real breakdown cancellation', async () => {
  const proto = await read('proto/bytemap.proto')
  const client = await read('src/main/scannerGrpcClient.ts')
  const adapter = await read('src/main/scanner.ts')
  const main = await read('src/main/index.ts')
  const pkg = await read('package.json')
  const vite = await read('electron.vite.config.ts')
  const builder = await read('electron-builder.yml')
  const rustMain = await read('native/src/main.rs')

  assert.match(proto, /service ScannerBackend/)
  assert.match(proto, /rpc DirBreakdown.*returns \(stream BreakdownEvent\)/)
  assert.match(proto, /rpc Cancel\(OperationRequest\)/)
  assert.match(client, /BYTEMAP_SCANNER_GRPC_READY/)
  assert.match(client, /loadScannerGrpcPackage/)
  assert.match(client, /child\.kill\('SIGTERM'\)/)
  assert.match(client, /grpc\.max_receive_message_length/)
  assert.match(client, /activeStreams/)
  assert.match(rustMain, /impl<T> Drop for EventStream<T>/)
  assert.match(rustMain, /self\.cancellation\.cancel\(\)/)
  assert.doesNotMatch(adapter, /require\(|\.node|NAPI/)
  assert.match(main, /cancelDirBreakdown/)
  assert.match(pkg, /build:scanner/)
  assert.match(builder, /MacOS\/bytemap-scanner/)
  assert.doesNotMatch(
    `${pkg}\n${vite}\n${builder}`,
    /@napi-rs|build:native|external: \['\.\.\/\.\.\/native'\]/
  )
})

test('cleanup scan batches result snapshots instead of copying once per item', async () => {
  const scan = await read('src/renderer/src/hooks/useScan.ts')

  assert.match(scan, /itemsRef\.current\.push\(item\)/)
  assert.match(scan, /onCategoryDone[\s\S]*setItems\(\[\.\.\.itemsRef\.current\]\)/)
  assert.doesNotMatch(scan, /itemsRef\.current\s*=\s*\[\.\.\.itemsRef\.current,\s*item\]/)
})

test('obsolete Codex advisor stack is absent from source contracts', async () => {
  const files = await Promise.all([
    read('package.json'),
    read('electron.vite.config.ts'),
    read('src/shared/types.ts'),
    read('src/main/index.ts'),
    read('src/preload/index.ts'),
    read('src/preload/index.d.ts')
  ])
  const joined = files.join('\n')
  assert.doesNotMatch(
    joined,
    /@openai\/codex|CodexAdvisor|advisor:ask|advisor:delta|CODEX_ADVISOR_SCHEMA|askCodexAdvisor|AdvisorWidget|useAdvisorChat/
  )
  assert.match(joined, /agent:ask/)
  assert.match(joined, /agent:event/)
  assert.match(joined, /BytemapAgentRequest/)
})
