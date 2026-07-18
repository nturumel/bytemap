import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  formatToolArgsText,
  mapOmpToolExecutionEvent,
  sanitizeSecrets,
  toolResultText
} from '../src/shared/agentToolDisplay.ts'

test('tool_execution_start maps bash args.command into argsText', () => {
  const mapped = mapOmpToolExecutionEvent('tool_execution_start', {
    toolCallId: 'call-1',
    toolName: 'bash',
    args: { command: 'du -sh ~/Library/Caches/* | sort -h | tail -20' },
    intent: 'Inspect caches'
  })
  assert.deepEqual(mapped, {
    toolName: 'bash',
    toolCallId: 'call-1',
    argsText: 'du -sh ~/Library/Caches/* | sort -h | tail -20'
  })
})

test('tool_execution_update replaces with full partialResult snapshot text', () => {
  const mapped = mapOmpToolExecutionEvent('tool_execution_update', {
    toolCallId: 'call-1',
    toolName: 'bash',
    args: { command: 'echo hello' },
    partialResult: {
      content: [{ type: 'text', text: 'hello\nworld' }],
      details: {}
    }
  })
  assert.equal(mapped?.argsText, 'echo hello')
  assert.equal(mapped?.text, 'hello\nworld')
})

test('tool_execution_end uses isError and result content', () => {
  const ok = mapOmpToolExecutionEvent('tool_execution_end', {
    toolCallId: 'call-1',
    toolName: 'bash',
    result: { content: [{ type: 'text', text: 'done' }], details: {} },
    isError: false
  })
  assert.equal(ok?.text, 'done')
  assert.equal(ok?.ok, true)

  const failed = mapOmpToolExecutionEvent('tool_execution_end', {
    toolCallId: 'call-2',
    toolName: 'bash',
    result: { content: [{ type: 'text', text: 'boom' }], details: {} },
    isError: true
  })
  assert.equal(failed?.ok, false)
  assert.equal(failed?.text, 'boom')
})

test('non-terminal tools format structured args', () => {
  assert.equal(
    formatToolArgsText('read', { path: '/Users/me/Documents/report.pdf', offset: 1, limit: 40 }),
    'path: /Users/me/Documents/report.pdf\noffset: 1\nlimit: 40'
  )
  assert.equal(
    formatToolArgsText('grep', { pattern: 'TODO', path: 'src', glob: '*.ts' }),
    'path: src\npattern: TODO\nglob: *.ts'
  )
})

test('toolResultText preserves line breaks and redacts secrets', () => {
  const text = toolResultText({
    content: [
      { type: 'text', text: 'OPENAI_API_KEY=sk-secret-value\nline two' },
      { type: 'text', text: 'line three' }
    ]
  })
  assert.equal(text, 'OPENAI_API_KEY=[REDACTED]\nline two\nline three')
  assert.match(sanitizeSecrets('Authorization: Bearer abc.def'), /\[REDACTED\]/)
})

test('empty partial results yield no output text', () => {
  assert.equal(
    mapOmpToolExecutionEvent('tool_execution_update', {
      toolName: 'bash',
      args: { command: 'sleep 1' },
      partialResult: { content: [], details: {} }
    })?.text,
    undefined
  )
})
