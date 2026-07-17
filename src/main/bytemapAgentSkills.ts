import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'

const SKILLS: { name: string; description: string; contract: string }[] = [
  {
    name: 'bytemap-filesystem-operator',
    description: 'Operate on user-requested local filesystem targets from Bytemap.',
    contract:
      'Find, inspect, move, trash, or remove user-requested local paths. Verify exact targets first. Prefer Trash for user data. Use permanent remove only for explicit user requests or known regenerable caches/logs/tooling. Report changed paths.'
  },
  {
    name: 'bytemap-code-bulk-cleaner',
    description: 'Clean generated project bulk before cloud movement or backup.',
    contract:
      'Before moving a project/folder to cloud storage, inspect for generated or reproducible code bulk: node_modules, .next, dist, build, target, coverage, .turbo, .parcel-cache, .vite, .gradle, DerivedData, package-manager caches, virtualenvs, temp files, and logs. Prefer deleting/regenerating these artifacts over backing them up or syncing them to cloud. Never delete source, lockfiles, config, or user documents as part of this cleanup unless explicitly requested.'
  },
  {
    name: 'bytemap-cache-inspector',
    description: 'Inspect Bytemap SQLite cache databases safely.',
    contract:
      'Inspect Bytemap’s local SQLite caches from `scan-cache.db` and `disk-map-cache.db`. Prefer schema-aware SQL queries over dumping entire tables. Summarize rows; do not exfiltrate or upload data.'
  },
  {
    name: 'bytemap-cleanup-advisor',
    description: 'Explain cleanup categories, tiers, and risks using app context plus local inspection.',
    contract:
      'Use Bytemap context and local inspection to explain why a target is cleanupable, what is user data versus generated data, and what verification should happen before cleanup. Do not replace explicit user approval for destructive operations.'
  },
  {
    name: 'bytemap-disk-map-advisor',
    description: 'Reason about visible disk-map nodes and cached disk-map views.',
    contract:
      'Use current disk-map context, cache paths, and filesystem inspection to explain visible storage hotspots. Prefer targeted inspection of selected nodes over broad scans. Preserve unrelated files.'
  },
  {
    name: 'bytemap-cloud-offload-advisor',
    description: 'Evaluate cloud movement only after cleanupable bulk is considered.',
    contract:
      'Before recommending cloud movement, first consider whether the target contains cleanupable generated/temp/code bulk. Inspect provider-local metadata when present. Treat sync as not equivalent to backup unless upload status is explicit. Do not upload/offload without explicit user request.'
  },
  {
    name: 'bytemap-deletion-policy',
    description: 'Apply Bytemap deletion safety dispositions.',
    contract:
      'Bytemap has three dispositions: recoverable Trash, explicit permanent remove for known-safe caches/logs/tooling or explicit user requests, and irreversible Docker prune. Do not upgrade a Trash/caution/user-file item to permanent delete without explicit user request or known-regenerable evidence. Global Empty Trash is unrelated to item cleanup and requires explicit same-turn request.'
  },
  {
    name: 'bytemap-permission-recovery',
    description: 'Recover from permission failures through exact-path retries and helper guidance.',
    contract:
      'Inspect permission failures and, when the user asks, retry exact paths with the helper CLI or admin prompt path. Preserve SIP/Xcode Simulator warnings.'
  }
]

function skillMarkdown(skill: (typeof SKILLS)[number]): string {
  return `# ${skill.name}

${skill.description}

## Behavior contract

${skill.contract}
`
}

async function writeIfChanged(path: string, content: string): Promise<void> {
  try {
    if ((await readFile(path, 'utf8')) === content) return
  } catch {
    // Missing or unreadable skill file is repaired by writing the desired copy.
  }
  await writeFile(path, content, { mode: 0o600 })
}

export async function ensureBytemapAgentSkills(agentDir: string): Promise<string[]> {
  const skillsRoot = join(agentDir, 'skills')
  await mkdir(skillsRoot, { recursive: true, mode: 0o700 })
  const written: string[] = []
  for (const skill of SKILLS) {
    const skillDir = join(skillsRoot, skill.name)
    await mkdir(skillDir, { recursive: true, mode: 0o700 })
    const skillPath = join(skillDir, 'SKILL.md')
    await writeIfChanged(skillPath, skillMarkdown(skill))
    written.push(skillPath)
  }
  return written
}

export const BYTEMAP_AGENT_SKILL_NAMES = SKILLS.map((skill) => skill.name)
