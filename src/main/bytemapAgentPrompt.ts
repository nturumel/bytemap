import { homedir } from 'os'
import { join } from 'path'
import type { BytemapAgentRequest, OmpProviderSummary, PrivilegedHelperState } from '@shared/types'

export const BYTEMAP_AGENT_SYSTEM_PROMPT = `You are Bytemap's local agent running inside the user's macOS disk cleanup app.

You may use the terminal and filesystem tools available in this OMP session. You may find, inspect, move, trash, and remove local files when the user asks. You have full local access; use it to verify facts instead of guessing.

Local state starts in Bytemap's userData directory. OMP auth/config and the embedded OMP HOME live in Bytemap's app-scoped omp-home, not the user's normal home or ~/.omp home. The user's real macOS home is supplied every turn as realHome and must be used for user cleanup targets. Important paths are supplied every turn: scan-cache.db, disk-map-cache.db, app-local skills, runtime diagnostics, current renderer context JSON, selected OMP model/provider, and the packaged Bytemap helper control binary when available.

Storage workflow policy:
- Before recommending moving a project or folder to cloud storage, inspect whether it contains generated/reproducible waste such as node_modules, .next, dist, build, target, DerivedData, package-manager caches, temp folders, logs, coverage, virtualenvs, or other rebuildable artifacts.
- Prefer cleaning generated/temp/code bulk first, then move or back up only the remaining valuable source/user files when the user asks.
- Do not move dependency folders such as node_modules to cloud as if they were user data; remove/regenerate them instead when safe.

File-operation policy:
- Verify the exact target path before moving, trashing, or removing it.
- Prefer moving user data to ~/.Trash unless the user explicitly asks for permanent removal or the target is a known regenerable cache/log/tooling artifact.
- Never empty the global Trash unless the user explicitly asks for global Trash emptying in the same turn.
- Do not upload, sync, or offload files to a cloud provider unless the user explicitly asks.
- Do not operate on unrelated paths just because they are large.
- Report exactly what commands or file operations changed, and what failed.

Answer in concise Markdown. If you need to run tools, run them; do not ask the user to perform terminal steps that you can perform locally.`

export type BytemapAgentProviderState = {
  selectedModelId: string | null
  providers: OmpProviderSummary[]
}

export type BytemapAgentStateBlockArgs = {
  request: BytemapAgentRequest
  providerState: BytemapAgentProviderState
  helperCtlPath: string | null
  helperState: PrivilegedHelperState
  fullDiskAccess: boolean
}

export function bytemapAgentPaths(): {
  userData: string
  ompHome: string
  agentDir: string
  cwd: string
  realHome: string
  scanCacheDb: string
  diskMapCacheDb: string
  skillsRoot: string
  runtimeDiagnostics: string
} {
  const userData = process.env.BYTEMAP_USER_DATA || process.env.HOME || homedir()
  const realHome = process.env.BYTEMAP_REAL_HOME || homedir()
  const ompHome = join(userData, 'omp-home')
  const agentDir = join(ompHome, 'agent')
  return {
    userData,
    ompHome,
    agentDir,
    cwd: userData,
    realHome,
    scanCacheDb: join(userData, 'scan-cache.db'),
    diskMapCacheDb: join(userData, 'disk-map-cache.db'),
    skillsRoot: join(agentDir, 'skills'),
    runtimeDiagnostics: join(userData, 'diagnostics', 'runtime-events.ndjson')
  }
}

export function buildBytemapAgentStateBlock({
  request,
  providerState,
  helperCtlPath,
  helperState,
  fullDiskAccess
}: BytemapAgentStateBlockArgs): string {
  const paths = bytemapAgentPaths()
  const availableProviderIds = providerState.providers
    .filter((provider) => provider.status === 'available')
    .map((provider) => provider.id)
    .join(', ')

  return `Bytemap agent state:
- userData: ${paths.userData}
- ompHome: ${paths.ompHome}
- agentDir: ${paths.agentDir}
- cwd: ${paths.cwd}
- realHome: ${paths.realHome}
- scanCacheDb: ${paths.scanCacheDb}
- diskMapCacheDb: ${paths.diskMapCacheDb}
- skillsRoot: ${paths.skillsRoot}
- runtimeDiagnostics: ${paths.runtimeDiagnostics}
- selectedModelId: ${providerState.selectedModelId ?? 'null'}
- availableProviderIds: ${availableProviderIds || 'none'}
- helperCtl: ${helperCtlPath ?? 'null'}
- helperStatus: ${JSON.stringify(helperState)}
- fullDiskAccess: ${fullDiskAccess}

Cache schemas:
- scan-cache.db: table file_hashes.
- disk-map-cache.db: tables disk_map_meta(key,value), disk_map_views(path,measured_at,stale,total_bytes,node_count), disk_map_nodes(view_path,path,name,size_bytes,is_dir,rank), index idx_disk_map_nodes_view_rank.

contextJson:
${JSON.stringify(request.context, null, 2)}`
}

export function buildBytemapAgentPrompt(
  request: BytemapAgentRequest,
  stateBlock: string,
  isFirstTurn: boolean
): string {
  return `${isFirstTurn ? `${BYTEMAP_AGENT_SYSTEM_PROMPT}\n\n` : ''}${stateBlock}

User message:
${request.message}`
}
