/** Helpers for mapping OMP tool_execution_* payloads into Bytemap chat tool cards. */

const COMMAND_TOOLS = new Set(['bash', 'shell', 'exec'])

const PREFERRED_ARG_KEYS = [
  'command',
  'path',
  'file',
  'oldPath',
  'newPath',
  'from',
  'to',
  'destination',
  'pattern',
  'glob',
  'query',
  'url',
  'cwd',
  'workingDirectory',
  'offset',
  'limit'
] as const

export type MappedToolFields = {
  toolName: string
  toolCallId?: string
  argsText?: string
  text?: string
  ok?: boolean
}

export function isCommandToolName(toolName: string): boolean {
  return COMMAND_TOOLS.has(toolName)
}

export function mapOmpToolExecutionEvent(
  eventType: string,
  event: Record<string, unknown>
): MappedToolFields | null {
  const toolName = typeof event.toolName === 'string' ? event.toolName : 'tool'
  const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : undefined
  const args = event.args
  const argsText =
    formatToolArgsText(toolName, args) ??
    (typeof event.intent === 'string' ? sanitizeToolText(event.intent) : undefined)

  if (eventType === 'tool_execution_start') {
    return { toolName, toolCallId, argsText }
  }

  if (eventType === 'tool_execution_update') {
    const text = toolResultText(event.partialResult)
    return {
      toolName,
      toolCallId,
      argsText,
      text: text ?? undefined
    }
  }

  if (eventType === 'tool_execution_end') {
    const text = toolResultText(event.result)
    return {
      toolName,
      toolCallId,
      argsText,
      text: text ?? undefined,
      ok: event.isError !== true && event.ok !== false
    }
  }

  return null
}

export function formatToolArgsText(toolName: string, args: unknown): string | undefined {
  const record = asRecord(args)
  if (!record) {
    if (typeof args === 'string' && args.trim()) return sanitizeToolText(args)
    return undefined
  }

  if (isCommandToolName(toolName)) {
    const command = stringProp(record, 'command')
    if (command) return sanitizeSecrets(command)
  }

  const lines: string[] = []
  const seen = new Set<string>()

  for (const key of PREFERRED_ARG_KEYS) {
    if (!(key in record) || key === 'command') continue
    const formatted = formatArgValue(key, record[key])
    if (!formatted) continue
    lines.push(formatted)
    seen.add(key)
  }

  for (const [key, value] of Object.entries(record)) {
    if (seen.has(key) || key === 'command' || key === 'intent') continue
    if (value === undefined || value === null) continue
    const formatted = formatArgValue(key, value)
    if (formatted) lines.push(formatted)
  }

  if (lines.length === 0) {
    try {
      const json = JSON.stringify(record, null, 2)
      return json && json !== '{}' ? sanitizeSecrets(json) : undefined
    } catch {
      return undefined
    }
  }

  return sanitizeSecrets(lines.join('\n'))
}

export function toolResultText(value: unknown): string | null {
  const text = extractText(value)
  if (!text.trim()) return null
  return sanitizeToolText(text)
}

export function sanitizeToolText(value: string): string {
  const sanitized = value
    .split(/\r?\n/)
    .filter(
      (line) =>
        !line.startsWith(
          '** WARNING: connection is not using a post-quantum key exchange algorithm.'
        )
    )
    .filter((line) => !line.startsWith('** This session may be vulnerable'))
    .filter((line) => !line.startsWith('** The server may need to be upgraded.'))
    .filter((line) => !line.startsWith('Warning: Permanently added '))
    .filter((line) => line !== '\\S')
    .filter((line) => line !== 'Kernel \\r on an \\m')
    .join('\n')
  const cleaned = sanitized.trim() ? sanitized : value
  return sanitizeSecrets(cleaned)
}

export function sanitizeSecrets(value: string): string {
  return value
    .replace(/(OPENAI_API_KEY=)[^\s"']+/giu, '$1[REDACTED]')
    .replace(/(OPENAI_CODEX_OAUTH_TOKEN=)[^\s"']+/giu, '$1[REDACTED]')
    .replace(/(ANTHROPIC_API_KEY=)[^\s"']+/giu, '$1[REDACTED]')
    .replace(/(ANTHROPIC_OAUTH_TOKEN=)[^\s"']+/giu, '$1[REDACTED]')
    .replace(/(GEMINI_API_KEY=)[^\s"']+/giu, '$1[REDACTED]')
    .replace(/(CURSOR_ACCESS_TOKEN=)[^\s"']+/giu, '$1[REDACTED]')
    .replace(/(COPILOT_GITHUB_TOKEN=)[^\s"']+/giu, '$1[REDACTED]')
    .replace(/(Authorization:\s*Bearer\s+)[^\s"']+/giu, '$1[REDACTED]')
    .replace(
      /((?:password|passwd|token|secret|private[_-]?key|ssh[_-]?identity)\s*[:=]\s*)[^\s"']+/giu,
      '$1[REDACTED]'
    )
}

function formatArgValue(key: string, value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? `${key}: ${trimmed}` : null
  }
  if (typeof value === 'number' || typeof value === 'boolean') return `${key}: ${String(value)}`
  if (Array.isArray(value)) {
    if (value.length === 0) return null
    if (value.every((item) => typeof item === 'string' || typeof item === 'number')) {
      return `${key}: ${value.join(', ')}`
    }
    try {
      return `${key}: ${JSON.stringify(value)}`
    } catch {
      return null
    }
  }
  if (asRecord(value)) {
    try {
      return `${key}: ${JSON.stringify(value)}`
    } catch {
      return null
    }
  }
  return null
}

function stringProp(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join('\n')
  const record = asRecord(value)
  if (!record) return ''
  if (typeof record.text === 'string') return record.text
  if (typeof record.output === 'string') return record.output
  if (typeof record.content === 'string') return record.content
  if (Array.isArray(record.content))
    return record.content.map(extractText).filter(Boolean).join('\n')
  if (Array.isArray(record.parts)) return record.parts.map(extractText).filter(Boolean).join('\n')
  if (record.details !== undefined) {
    const fromDetails = extractText(record.details)
    if (fromDetails) return fromDetails
  }
  return ''
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
