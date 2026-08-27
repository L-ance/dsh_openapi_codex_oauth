import assert from 'node:assert/strict'
import test from 'node:test'
import { CodexAppServerAdapter } from '../lib/index.js'

class FakeServer {
  accountRevision = 1
  events = []
  responses = []
  turnInput = ''

  async account() { return { type: 'chatgpt', planType: 'plus' } }
  async models() {
    return [{
      id: 'gpt-test-codex',
      model: 'gpt-test-codex',
      displayName: 'GPT Test Codex',
      hidden: false,
      inputModalities: ['text', 'image'],
      defaultReasoningEffort: 'high',
      supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }],
    }]
  }
  async rateLimits() { return {} }
  async startBrowserLogin() { return {} }
  async startDeviceLogin() { return {} }
  async logout() {}
  async startThread() { return 'thread-1' }
  async startTurn(_threadId, input) {
    this.turnInput = input.input[0].text
    this.events.push({
      method: 'item/tool/call',
      requestId: 7,
      params: {
        threadId: 'thread-1',
        callId: 'call-1',
        tool: 'echo',
        arguments: { text: 'ping' },
      },
    })
    return 'turn-1'
  }
  nextEvent(_threadId, signal) {
    const event = this.events.shift()
    if (event !== undefined) return Promise.resolve(event)
    return new Promise((_resolve, reject) => {
      const abort = () => reject(signal?.reason ?? new Error('aborted'))
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
    })
  }
  respond(id, result) {
    this.responses.push({ id, result })
    this.events.push(
      {
        method: 'item/agentMessage/delta',
        params: { threadId: 'thread-1', itemId: 'answer', delta: 'pong' },
      },
      {
        method: 'item/completed',
        params: { threadId: 'thread-1', item: { id: 'answer', type: 'agentMessage' } },
      },
      {
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
      },
    )
  }
  async interrupt() {}
  close() {}
}

const base = {
  provider: 'openai-codex',
  model: 'gpt-test-codex',
  sessionId: 'session-1',
  tools: [{ name: 'echo', description: 'echo', parameters: { type: 'object' } }],
}

test('bridges a Codex dynamic tool call through the DSH loop', async () => {
  const server = new FakeServer()
  const adapter = new CodexAppServerAdapter(server)
  const first = await Array.fromAsync(adapter.stream({
    ...base,
    messages: [
      { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'ping' }] },
      { id: 'u2', role: 'user', source: { kind: 'plugin', plugin: 'context' }, content: [{ type: 'text', text: 'runtime context' }] },
    ],
  }))

  assert.equal(server.turnInput, 'ping\n\nruntime context')
  assert.deepEqual(first.at(-1).reason, { kind: 'tool-calls' })
  assert.equal(first.find(chunk => chunk.type === 'block-end').block.id, 'call-1')

  const second = await Array.fromAsync(adapter.stream({
    ...base,
    messages: [
      { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'ping' }] },
      {
        id: 'a1',
        role: 'assistant',
        source: { kind: 'model', provider: 'openai-codex', model: 'gpt-test-codex' },
        content: [{ type: 'tool-call', id: 'call-1', name: 'echo', arguments: '{"text":"ping"}' }],
      },
      {
        id: 't1',
        role: 'user',
        source: { kind: 'tool', callId: 'call-1' },
        content: [{
          type: 'tool-result',
          toolCallId: 'call-1',
          content: [{ type: 'text', text: 'pong-from-dsh' }],
          isError: false,
        }],
      },
    ],
  }))

  assert.equal(server.responses[0].result.contentItems[0].text, 'pong-from-dsh')
  assert.equal(second.find(chunk => chunk.type === 'block-end').block.text, 'pong')
  assert.deepEqual(second.at(-1).reason, { kind: 'stop' })
})

test('discovers models dynamically and advertises only implemented modalities', async () => {
  const adapter = new CodexAppServerAdapter(new FakeServer())
  const models = await adapter.listModels()
  assert.equal(models[0].id, 'gpt-test-codex')
  assert.deepEqual(models[0].inputModalities, ['text'])
  const resolved = await adapter.resolveModel('openai-codex', 'gpt-test-codex')
  assert.equal(resolved.reasoning.defaultEffort, 'high')
})

test('interrupts App Server when DSH aborts a turn', async () => {
  const server = new FakeServer()
  let interrupted = false
  server.startTurn = async () => 'turn-1'
  server.interrupt = async () => { interrupted = true }
  const controller = new AbortController()
  const result = Array.fromAsync(new CodexAppServerAdapter(server).stream({
    ...base,
    signal: controller.signal,
    messages: [{ id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'wait' }] }],
  }))
  controller.abort()
  await assert.rejects(result)
  assert.equal(interrupted, true)
})
