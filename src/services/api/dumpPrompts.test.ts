import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  createDumpPromptsFetch,
  getDumpPromptsPath,
} from './dumpPrompts.js'

// --- Environment setup ---

type FetchType = typeof globalThis.fetch

const TEST_DIR = join(tmpdir(), `claude-dump-test-${process.pid}-${Date.now()}`)
const originalFetch = globalThis.fetch
const savedEnv = {
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CLAUDE_CODE_DUMP_PROMPTS: process.env.CLAUDE_CODE_DUMP_PROMPTS,
  USER_TYPE: process.env.USER_TYPE,
}

function restoreEnv(key: string, val: string | undefined) {
  if (val === undefined) delete process.env[key]
  else process.env[key] = val
}

beforeEach(() => {
  process.env.CLAUDE_CONFIG_DIR = TEST_DIR
  process.env.CLAUDE_CODE_DUMP_PROMPTS = '1'
  delete process.env.USER_TYPE
})

afterEach(() => {
  globalThis.fetch = originalFetch
  for (const [k, v] of Object.entries(savedEnv)) restoreEnv(k, v)
  try {
    rmSync(TEST_DIR, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

// --- Helpers ---

/** Wait for setImmediate + async file I/O to settle. */
async function flush() {
  await new Promise(r => setImmediate(r))
  await new Promise(r => setTimeout(r, 100))
}

/**
 * Create a mock fetch that resolves after a minimal delay.
 *
 * In production, fetch always has network latency, giving the
 * setImmediate-deferred request dump time to mkdir the dump directory
 * before the response capture runs.  In tests the mock resolves
 * instantly, so the response IIFE races against the directory
 * creation.  A tiny delay avoids that race.
 */
function mockFetch(
  responseFn: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Response | Promise<Response>,
): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>(resolve => {
      setTimeout(async () => resolve(await responseFn(input, init)), 5)
    })
  }) as FetchType
}

let testCounter = 0
function uniqueId() {
  return `dump-test-${++testCounter}-${Date.now()}`
}

function makeRequestBody(
  overrides: {
    model?: string
    system?: string | Array<{ text: string }>
    tools?: Array<{ name: string }>
    messages?: Array<{ role: string; content: string }>
  } = {},
) {
  return JSON.stringify({
    model: overrides.model ?? 'claude-sonnet-4-20250514',
    system: overrides.system ?? 'You are helpful.',
    tools: overrides.tools ?? [{ name: 'Bash' }, { name: 'Read' }],
    messages: overrides.messages ?? [{ role: 'user', content: 'Hello' }],
  })
}

function makeJsonResponse(
  body: Record<string, unknown> = { id: 'msg_test', role: 'assistant' },
) {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeSseResponse(chunks: unknown[]) {
  const text =
    chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') +
    'data: [DONE]\n\n'
  return new Response(text, {
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

function readDumpEntries(
  sessionId: string,
): Array<{ type: string; timestamp: string; data: unknown }> {
  const path = getDumpPromptsPath(sessionId)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

// --- Tests ---

describe('getDumpPromptsPath', () => {
  test('constructs path under dump-prompts directory', () => {
    const path = getDumpPromptsPath('my-session')
    expect(path).toBe(join(TEST_DIR, 'dump-prompts', 'my-session.jsonl'))
  })
})

describe('createDumpPromptsFetch', () => {
  test('passes request through to underlying fetch', async () => {
    let capturedUrl: string | undefined
    let capturedInit: RequestInit | undefined

    mockFetch((input, init) => {
      capturedUrl =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      capturedInit = init
      return makeJsonResponse()
    })

    const id = uniqueId()
    const dumpFetch = createDumpPromptsFetch(id)
    const body = makeRequestBody()

    await dumpFetch('https://api.example.com/v1/messages', {
      method: 'POST',
      body,
    })

    expect(capturedUrl).toBe('https://api.example.com/v1/messages')
    expect(capturedInit?.method).toBe('POST')
    expect(capturedInit?.body).toBe(body)
  })

  test('writes init entry on first POST request', async () => {
    mockFetch(() => makeJsonResponse())

    const id = uniqueId()
    const dumpFetch = createDumpPromptsFetch(id)

    await dumpFetch('https://api.example.com/v1/messages', {
      method: 'POST',
      body: makeRequestBody(),
    })
    await flush()

    const entries = readDumpEntries(id)
    const initEntry = entries.find(e => e.type === 'init')
    expect(initEntry).toBeDefined()

    const data = initEntry!.data as Record<string, unknown>
    expect(data.model).toBe('claude-sonnet-4-20250514')
    expect(data.tools).toEqual([{ name: 'Bash' }, { name: 'Read' }])
    expect(data.messages).toBeUndefined()
  })

  test('writes user message entries', async () => {
    mockFetch(() => makeJsonResponse())

    const id = uniqueId()
    const dumpFetch = createDumpPromptsFetch(id)

    await dumpFetch('https://api.example.com/v1/messages', {
      method: 'POST',
      body: makeRequestBody({
        messages: [{ role: 'user', content: 'Hello world' }],
      }),
    })
    await flush()

    const entries = readDumpEntries(id)
    const msgEntries = entries.filter(e => e.type === 'message')
    expect(msgEntries).toHaveLength(1)

    const msgData = msgEntries[0]!.data as { role: string; content: string }
    expect(msgData.role).toBe('user')
    expect(msgData.content).toBe('Hello world')
  })

  test('does not duplicate init when fingerprint unchanged', async () => {
    mockFetch(() => makeJsonResponse())

    const id = uniqueId()
    const dumpFetch = createDumpPromptsFetch(id)

    await dumpFetch('https://api.example.com/v1/messages', {
      method: 'POST',
      body: makeRequestBody({
        messages: [{ role: 'user', content: 'First' }],
      }),
    })
    await flush()

    await dumpFetch('https://api.example.com/v1/messages', {
      method: 'POST',
      body: makeRequestBody({
        messages: [
          { role: 'user', content: 'First' },
          { role: 'assistant', content: 'Reply' },
          { role: 'user', content: 'Second' },
        ],
      }),
    })
    await flush()

    const entries = readDumpEntries(id)
    expect(entries.filter(e => e.type === 'init')).toHaveLength(1)
    expect(entries.filter(e => e.type === 'system_update')).toHaveLength(0)
  })

  test('writes system_update when tools change', async () => {
    mockFetch(() => makeJsonResponse())

    const id = uniqueId()
    const dumpFetch = createDumpPromptsFetch(id)

    await dumpFetch('https://api.example.com/v1/messages', {
      method: 'POST',
      body: makeRequestBody({
        tools: [{ name: 'Bash' }],
        messages: [{ role: 'user', content: 'First' }],
      }),
    })
    await flush()

    await dumpFetch('https://api.example.com/v1/messages', {
      method: 'POST',
      body: makeRequestBody({
        tools: [{ name: 'Bash' }, { name: 'Read' }, { name: 'Write' }],
        messages: [
          { role: 'user', content: 'First' },
          { role: 'assistant', content: 'Reply' },
          { role: 'user', content: 'Second' },
        ],
      }),
    })
    await flush()

    const entries = readDumpEntries(id)
    const updates = entries.filter(e => e.type === 'system_update')
    expect(updates).toHaveLength(1)

    const data = updates[0]!.data as { tools: Array<{ name: string }> }
    expect(data.tools.map(t => t.name)).toEqual(['Bash', 'Read', 'Write'])
  })

  test('writes only new user messages on subsequent requests', async () => {
    mockFetch(() => makeJsonResponse())

    const id = uniqueId()
    const dumpFetch = createDumpPromptsFetch(id)

    await dumpFetch('https://api.example.com/v1/messages', {
      method: 'POST',
      body: makeRequestBody({
        messages: [{ role: 'user', content: 'First' }],
      }),
    })
    await flush()

    await dumpFetch('https://api.example.com/v1/messages', {
      method: 'POST',
      body: makeRequestBody({
        messages: [
          { role: 'user', content: 'First' },
          { role: 'assistant', content: 'Reply' },
          { role: 'user', content: 'Second' },
        ],
      }),
    })
    await flush()

    const msgs = readDumpEntries(id).filter(e => e.type === 'message')
    expect(msgs).toHaveLength(2)
    expect((msgs[0]!.data as { content: string }).content).toBe('First')
    expect((msgs[1]!.data as { content: string }).content).toBe('Second')
  })

  test('captures JSON response', async () => {
    const responseBody = {
      id: 'msg_123',
      role: 'assistant',
      content: [{ text: 'Hi' }],
    }
    mockFetch(() => makeJsonResponse(responseBody))

    const id = uniqueId()
    const dumpFetch = createDumpPromptsFetch(id)

    await dumpFetch('https://api.example.com/v1/messages', {
      method: 'POST',
      body: makeRequestBody(),
    })
    await flush()

    const respEntry = readDumpEntries(id).find(e => e.type === 'response')
    expect(respEntry).toBeDefined()
    expect(respEntry!.data).toEqual(responseBody)
  })

  test('captures streaming SSE response', async () => {
    const chunks = [
      { type: 'content_block_start', index: 0 },
      { type: 'content_block_delta', delta: { text: 'Hello' } },
      { type: 'message_stop' },
    ]
    mockFetch(() => makeSseResponse(chunks))

    const id = uniqueId()
    const dumpFetch = createDumpPromptsFetch(id)

    await dumpFetch('https://api.example.com/v1/messages', {
      method: 'POST',
      body: makeRequestBody(),
    })
    await flush()

    const respEntry = readDumpEntries(id).find(e => e.type === 'response')
    expect(respEntry).toBeDefined()

    const respData = respEntry!.data as { stream: boolean; chunks: unknown[] }
    expect(respData.stream).toBe(true)
    expect(respData.chunks).toEqual(chunks)
  })

  test('does not dump error responses', async () => {
    mockFetch(() => new Response('Rate limited', { status: 429 }))

    const id = uniqueId()
    const dumpFetch = createDumpPromptsFetch(id)

    await dumpFetch('https://api.example.com/v1/messages', {
      method: 'POST',
      body: makeRequestBody(),
    })
    await flush()

    const entries = readDumpEntries(id)
    // Request-side entries (init, message) should still be written
    expect(entries.some(e => e.type === 'init')).toBe(true)
    // But response should NOT be captured for non-ok status
    expect(entries.filter(e => e.type === 'response')).toHaveLength(0)
  })

  test('returns response normally when request body is malformed JSON', async () => {
    const responseBody = { id: 'msg_ok', role: 'assistant' }
    mockFetch(() => makeJsonResponse(responseBody))

    const id = uniqueId()
    const dumpFetch = createDumpPromptsFetch(id)

    const response = await dumpFetch('https://api.example.com/v1/messages', {
      method: 'POST',
      body: 'not valid json {{{',
    })

    // The wrapper must not swallow or corrupt the response
    const body = await response.json()
    expect(body).toEqual(responseBody)
    expect(response.status).toBe(200)
  })

  test('writes system_update when model changes', async () => {
    mockFetch(() => makeJsonResponse())

    const id = uniqueId()
    const dumpFetch = createDumpPromptsFetch(id)

    await dumpFetch('https://api.example.com/v1/messages', {
      method: 'POST',
      body: makeRequestBody({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'First' }],
      }),
    })
    await flush()

    await dumpFetch('https://api.example.com/v1/messages', {
      method: 'POST',
      body: makeRequestBody({
        model: 'claude-opus-4-20250514',
        messages: [
          { role: 'user', content: 'First' },
          { role: 'assistant', content: 'Reply' },
          { role: 'user', content: 'Second' },
        ],
      }),
    })
    await flush()

    const entries = readDumpEntries(id)
    const updates = entries.filter(e => e.type === 'system_update')
    expect(updates).toHaveLength(1)

    const data = updates[0]!.data as { model: string }
    expect(data.model).toBe('claude-opus-4-20250514')
  })

  test('returned JSON response body is consumable by caller', async () => {
    const responseBody = { id: 'msg_123', role: 'assistant', content: 'Hi' }
    mockFetch(() => makeJsonResponse(responseBody))

    const id = uniqueId()
    const dumpFetch = createDumpPromptsFetch(id)

    const response = await dumpFetch('https://api.example.com/v1/messages', {
      method: 'POST',
      body: makeRequestBody(),
    })

    // The caller must be able to read the body even though
    // the wrapper internally clones and reads the response.
    const body = await response.json()
    expect(body).toEqual(responseBody)
  })

  test('returned streaming response body is consumable by caller', async () => {
    const chunks = [
      { type: 'content_block_start', index: 0 },
      { type: 'content_block_delta', delta: { text: 'Hello' } },
      { type: 'message_stop' },
    ]
    mockFetch(() => makeSseResponse(chunks))

    const id = uniqueId()
    const dumpFetch = createDumpPromptsFetch(id)

    const response = await dumpFetch('https://api.example.com/v1/messages', {
      method: 'POST',
      body: makeRequestBody(),
    })

    // The caller must be able to consume the original stream
    const text = await response.text()
    expect(text).toContain('content_block_start')
    expect(text).toContain('content_block_delta')
    expect(text).toContain('[DONE]')
  })

  test('skips dump when CLAUDE_CODE_DUMP_PROMPTS is unset', async () => {
    delete process.env.CLAUDE_CODE_DUMP_PROMPTS
    delete process.env.USER_TYPE

    mockFetch(() => makeJsonResponse())

    const id = uniqueId()
    const dumpFetch = createDumpPromptsFetch(id)

    await dumpFetch('https://api.example.com/v1/messages', {
      method: 'POST',
      body: makeRequestBody(),
    })
    await flush()

    const entries = readDumpEntries(id)
    expect(entries.filter(e => e.type === 'init')).toHaveLength(0)
    expect(entries.filter(e => e.type === 'message')).toHaveLength(0)
    expect(entries.filter(e => e.type === 'response')).toHaveLength(0)
  })

  test('skips dump for non-POST requests', async () => {
    mockFetch(() => new Response('ok'))

    const id = uniqueId()
    const dumpFetch = createDumpPromptsFetch(id)

    await dumpFetch('https://api.example.com/v1/messages', { method: 'GET' })
    await flush()

    expect(readDumpEntries(id)).toHaveLength(0)
  })

  test('enables dump via USER_TYPE=ant', async () => {
    delete process.env.CLAUDE_CODE_DUMP_PROMPTS
    process.env.USER_TYPE = 'ant'

    mockFetch(() => makeJsonResponse())

    const id = uniqueId()
    const dumpFetch = createDumpPromptsFetch(id)

    await dumpFetch('https://api.example.com/v1/messages', {
      method: 'POST',
      body: makeRequestBody(),
    })
    await flush()

    const entries = readDumpEntries(id)
    expect(entries.some(e => e.type === 'init')).toBe(true)
  })
})
