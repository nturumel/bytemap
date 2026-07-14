import { execFile } from 'child_process'
import { promisify } from 'util'
import type { DockerPruneTarget, ScanItem } from '@shared/types'

const execFileAsync = promisify(execFile)
const MIN_RECLAIMABLE = 10 * 1024 * 1024

const TARGETS: {
  type: string
  target: DockerPruneTarget
  label: string
  reason: string
}[] = [
  {
    type: 'Images',
    target: 'images',
    label: 'Docker images',
    reason: 'Dangling images not used by any container — re-pullable'
  },
  {
    type: 'Containers',
    target: 'containers',
    label: 'Docker containers',
    reason: 'Stopped containers'
  },
  {
    type: 'Local Volumes',
    target: 'volumes',
    label: 'Docker volumes',
    reason: 'Unused volumes — double check none hold data you still need'
  },
  {
    type: 'Build Cache',
    target: 'buildCache',
    label: 'Docker build cache',
    reason: 'Regenerates automatically on your next build'
  }
]

function parseSize(raw: string): number {
  const match = raw.trim().match(/^([\d.]+)\s*([a-zA-Z]+)/)
  if (!match) return 0
  const value = parseFloat(match[1])
  const multipliers: Record<string, number> = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12 }
  return Math.round(value * (multipliers[match[2].toLowerCase()] ?? 1))
}

export async function scanDocker(
  emit: (item: ScanItem) => void,
  progress: (msg: string) => void
): Promise<void> {
  progress('Checking Docker')
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync(
      'docker',
      ['system', 'df', '--format', '{{.Type}}\t{{.Size}}\t{{.Reclaimable}}'],
      { timeout: 5000 }
    ))
  } catch {
    return // Docker CLI not installed, or daemon not running — nothing to report
  }

  for (const line of stdout.trim().split('\n')) {
    const [type, , reclaimableRaw] = line.split('\t')
    const config = TARGETS.find((t) => t.type === type)
    if (!config || !reclaimableRaw) continue

    const bytes = parseSize(reclaimableRaw)
    if (bytes < MIN_RECLAIMABLE) continue

    emit({
      id: `caches:docker-${config.target}`,
      path: `docker://${config.target}`,
      name: config.label,
      sizeBytes: bytes,
      reason: config.reason,
      category: 'caches',
      action: { kind: 'dockerPrune', target: config.target }
    })
  }
}

const PRUNE_ARGS: Record<DockerPruneTarget, string[]> = {
  images: ['image', 'prune', '-f'],
  containers: ['container', 'prune', '-f'],
  volumes: ['volume', 'prune', '-f'],
  buildCache: ['builder', 'prune', '-f']
}

export async function runDockerPrune(target: DockerPruneTarget): Promise<void> {
  await execFileAsync('docker', PRUNE_ARGS[target], { timeout: 60_000 })
}
