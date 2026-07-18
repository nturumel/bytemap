/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { mkdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

rmSync('out/agent-backend', { recursive: true, force: true })
mkdirSync('out/agent-backend', { recursive: true })

const result = spawnSync(
  'bun',
  [
    'build',
    'src/main/agentBackendServer.ts',
    '--target=bun',
    '--format=esm',
    '--outfile=out/agent-backend/agentBackendServer.mjs'
  ],
  { stdio: 'inherit' }
)

if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
