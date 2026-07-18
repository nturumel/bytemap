export const CLEANUP_PLAN_FENCE = 'bytemap-cleanup-plan'

export type CleanupPlanTierId = 'easy' | 'optional' | 'keep'
export type CleanupPlanAction = 'trash' | 'permanent' | 'keep'

export type CleanupPlanItem = {
  name: string
  path: string
  sizeBytes: number | null
  reason: string
  action: CleanupPlanAction
}

export type CleanupPlanTier = {
  tier: CleanupPlanTierId
  items: CleanupPlanItem[]
  knownBytes: number
  unknownSizeCount: number
}

export type CleanupPlan = {
  summary: string
  tiers: CleanupPlanTier[]
  knownCandidateBytes: number
  unknownCandidateCount: number
}

export type ParsedAgentAnswer = {
  markdown: string
  plan: CleanupPlan | null
  planStreaming: boolean
}

const PLAN_START = new RegExp(`\\\`\\\`\\\`${CLEANUP_PLAN_FENCE}\\s*`, 'i')
const TIER_IDS: CleanupPlanTierId[] = ['easy', 'optional', 'keep']
const ACTIONS: CleanupPlanAction[] = ['trash', 'permanent', 'keep']

export function parseAgentAnswer(text: string): ParsedAgentAnswer {
  const start = PLAN_START.exec(text)
  if (!start) return { markdown: text, plan: null, planStreaming: false }

  const contentStart = start.index + start[0].length
  const contentEnd = text.indexOf('```', contentStart)
  const markdownBefore = text.slice(0, start.index).trimEnd()
  if (contentEnd < 0) {
    return { markdown: markdownBefore, plan: null, planStreaming: true }
  }

  try {
    const plan = parseCleanupPlan(JSON.parse(text.slice(contentStart, contentEnd)))
    const markdownAfter = text.slice(contentEnd + 3).trim()
    return {
      markdown: [markdownBefore, markdownAfter].filter(Boolean).join('\n\n'),
      plan,
      planStreaming: false
    }
  } catch {
    return { markdown: text, plan: null, planStreaming: false }
  }
}

function parseCleanupPlan(value: unknown): CleanupPlan {
  const record = asRecord(value)
  if (!record || record.version !== 1 || typeof record.summary !== 'string') {
    throw new Error('Invalid cleanup plan header')
  }
  if (!Array.isArray(record.tiers)) throw new Error('Invalid cleanup plan tiers')

  const providedTiers = new Map<CleanupPlanTierId, CleanupPlanItem[]>()
  for (const valueTier of record.tiers) {
    const tierRecord = asRecord(valueTier)
    if (!tierRecord || !isTierId(tierRecord.tier) || !Array.isArray(tierRecord.items)) {
      throw new Error('Invalid cleanup plan tier')
    }
    if (providedTiers.has(tierRecord.tier)) throw new Error('Duplicate cleanup plan tier')
    providedTiers.set(tierRecord.tier, tierRecord.items.map(parseCleanupItem))
  }

  const tiers = TIER_IDS.map((tier) => summarizeTier(tier, providedTiers.get(tier) ?? []))
  const candidates = tiers.filter((tier) => tier.tier !== 'keep')
  return {
    summary: record.summary.trim(),
    tiers,
    knownCandidateBytes: candidates.reduce((total, tier) => total + tier.knownBytes, 0),
    unknownCandidateCount: candidates.reduce((total, tier) => total + tier.unknownSizeCount, 0)
  }
}

function parseCleanupItem(value: unknown): CleanupPlanItem {
  const record = asRecord(value)
  if (
    !record ||
    typeof record.name !== 'string' ||
    typeof record.path !== 'string' ||
    typeof record.reason !== 'string' ||
    !isAction(record.action)
  ) {
    throw new Error('Invalid cleanup plan item')
  }

  const sizeBytes =
    record.sizeBytes === null
      ? null
      : typeof record.sizeBytes === 'number' &&
          Number.isFinite(record.sizeBytes) &&
          record.sizeBytes >= 0
        ? Math.floor(record.sizeBytes)
        : undefined
  if (sizeBytes === undefined) throw new Error('Invalid cleanup plan item size')

  return {
    name: record.name.trim() || record.path,
    path: record.path,
    sizeBytes,
    reason: record.reason.trim(),
    action: record.action
  }
}

function summarizeTier(tier: CleanupPlanTierId, items: CleanupPlanItem[]): CleanupPlanTier {
  return {
    tier,
    items,
    knownBytes: items.reduce((total, item) => total + (item.sizeBytes ?? 0), 0),
    unknownSizeCount: items.filter((item) => item.sizeBytes === null).length
  }
}

function isTierId(value: unknown): value is CleanupPlanTierId {
  return typeof value === 'string' && TIER_IDS.includes(value as CleanupPlanTierId)
}

function isAction(value: unknown): value is CleanupPlanAction {
  return typeof value === 'string' && ACTIONS.includes(value as CleanupPlanAction)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
