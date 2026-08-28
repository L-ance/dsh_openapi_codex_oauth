import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  CallId,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  LlmModelInfo,
  LlmResolvedModelInfo,
  StreamChunk,
  ToolResultBlock,
} from '@deepseek-ai/dsh-llm'
import {
  AppServer,
  type AppServerEvent,
  type CodexAppServerApi,
  type JsonObject,
} from './app-server.js'
import { oauthRoute } from './oauth-http.js'

export const name = 'llm-codex-app-server'
export const inject = ['llm']

export const CODEX_PROVIDER_ID = 'openai-codex'
const REPLAY_KIND = 'dsh-codex-app-server'
const MAX_LIVE_SESSIONS = 128
const MAX_DYNAMIC_TOOL_NAME_LENGTH = 64

interface DynamicToolBinding {
  dshName: string
  wireName: string
  definition: JsonObject
}

interface PendingToolCall {
  requestId: string | number
  callId: string
  name: string
  arguments: unknown
}

interface ProviderSession {
  threadId: string
  toolFingerprint: string
  toolNames: Map<string, string>
  pendingTools: PendingToolCall[]
  backlog: AppServerEvent[]
  touchedAt: number
  busy: boolean
  turnId?: string
}

interface ModelCache {
  accountRevision: number
  models: JsonObject[]
}

function contentText(blocks: readonly ContentBlock[]): string {
  return blocks.map((block) => {
    if (block.type === 'text') return block.text
    if (block.type === 'tool-result') return contentText(block.content)
    if (block.type === 'tool-call') return `[tool call ${block.name}: ${block.arguments}]`
    return ''
  }).filter(Boolean).join('\n')
}

function textSinceLastAssistant(options: GenerateOptions): string {
  const lastAssistant = options.messages.findLastIndex(message => message.role === 'assistant')
  return options.messages.slice(lastAssistant + 1)
    .filter(message => message.role === 'user')
    .map(message => contentText(message.content))
    .filter(Boolean)
    .join('\n\n')
}

/** Recover useful context if DSH resumed a session after this process restarted. */
function restoredConversation(options: GenerateOptions): string | undefined {
  if (!options.messages.some(message => message.role === 'assistant')) return undefined
  const transcript = options.messages.map((message) => {
    const role = message.role === 'assistant' ? 'Assistant' : 'User/Tool'
    return `${role}:\n${contentText(message.content) || '(no text content)'}`
  }).join('\n\n')
  return [
    'The DeepSeek Harness process resumed an existing session. Reconstruct context from this transcript:',
    transcript,
    'Continue from the final user/tool message.',
  ].join('\n\n')
}

function toolResults(options: GenerateOptions): Map<string, ToolResultBlock> {
  const results = new Map<string, ToolResultBlock>()
  for (const message of options.messages) {
    for (const block of message.content) {
      if (block.type === 'tool-result') results.set(block.toolCallId, block)
    }
  }
  return results
}

function dynamicToolBindings(options: GenerateOptions): DynamicToolBinding[] {
  return (options.tools ?? []).map((tool, index) => {
    const prefix = `dsh_${String(index)}_`
    const normalized = tool.name.replace(/[^A-Za-z0-9_-]/g, '_')
    const wireName = `${prefix}${normalized.slice(0, MAX_DYNAMIC_TOOL_NAME_LENGTH - prefix.length)}`
    return {
      dshName: tool.name,
      wireName,
      definition: {
        type: 'function',
        name: wireName,
        description: tool.description,
        inputSchema: tool.parameters,
      },
    }
  })
}

function dynamicToolFingerprint(bindings: DynamicToolBinding[]): string {
  return JSON.stringify(bindings.map(binding => ({
    dshName: binding.dshName,
    definition: binding.definition,
  })))
}

function sessionKey(options: GenerateOptions): string {
  return String(options.sessionId ?? options.messages[0]?.id ?? 'one-shot')
}

function threadItem(event: AppServerEvent): JsonObject | undefined {
  const item = event.params.item
  return item !== null && typeof item === 'object' ? item as JsonObject : undefined
}

function modelId(model: JsonObject): string {
  return String(model.model ?? model.id ?? '')
}

function visibleModels(models: JsonObject[]): JsonObject[] {
  return models.filter(model => model.hidden !== true && modelId(model).length > 0)
}

function toolArguments(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? {})
}

export class CodexAppServerAdapter extends LlmAdapter {
  private readonly sessions = new Map<string, ProviderSession>()
  private modelCache: ModelCache | undefined

  constructor(private readonly server: CodexAppServerApi = new AppServer()) {
    super()
  }

  override providerInfo(): { id: string; name: string } {
    return { id: CODEX_PROVIDER_ID, name: 'OpenAI Codex (ChatGPT OAuth)' }
  }

  private async models(): Promise<JsonObject[]> {
    if (this.modelCache?.accountRevision === this.server.accountRevision) {
      return this.modelCache.models
    }
    const account = await this.server.account()
    if (account?.type !== 'chatgpt') {
      this.modelCache = undefined
      throw new LlmError(
        'OpenAI Codex is not signed in. Open Settings > OpenAI OAuth or run dsh-codex-login.',
        'MISSING_CREDENTIAL',
      )
    }
    const models = visibleModels(await this.server.models())
    this.modelCache = { accountRevision: this.server.accountRevision, models }
    return models
  }

  override async listModels(): Promise<readonly LlmModelInfo[]> {
    return (await this.models()).map(model => ({
      provider: CODEX_PROVIDER_ID,
      id: modelId(model),
      name: String(model.displayName ?? modelId(model)),
      ...(typeof model.description === 'string' ? { description: model.description } : {}),
      // The App Server can accept images, but translating DSH image blocks is not
      // implemented yet. Advertising text-only makes DSH fail before network I/O.
      inputModalities: ['text'],
    }))
  }

  override async resolveModel(provider: string, requestedModel: string): Promise<LlmResolvedModelInfo> {
    const model = (await this.models()).find(entry => modelId(entry) === requestedModel)
    if (model === undefined) {
      throw new LlmError(`The signed-in Codex account does not expose model "${requestedModel}".`, 'UNKNOWN_MODEL')
    }

    const efforts = Array.isArray(model.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts.flatMap((raw) => {
        if (raw === null || typeof raw !== 'object') return []
        const entry = raw as JsonObject
        if (typeof entry.reasoningEffort !== 'string') return []
        return [{
          id: ReasoningEffortId(entry.reasoningEffort),
          name: entry.reasoningEffort,
          description: typeof entry.description === 'string' ? entry.description : '',
        }]
      })
      : []

    return {
      provider,
      id: requestedModel,
      name: String(model.displayName ?? requestedModel),
      ...(typeof model.description === 'string' ? { description: model.description } : {}),
      inputModalities: ['text'],
      ...(efforts.length > 0 && typeof model.defaultReasoningEffort === 'string'
        ? {
            reasoning: {
              efforts,
              defaultEffort: ReasoningEffortId(model.defaultReasoningEffort),
            },
          }
        : {}),
    }
  }

  private evictIdleSession(): void {
    if (this.sessions.size < MAX_LIVE_SESSIONS) return
    const candidate = [...this.sessions.entries()]
      .filter(([, session]) => !session.busy && session.pendingTools.length === 0)
      .sort((left, right) => left[1].touchedAt - right[1].touchedAt)[0]
    if (candidate !== undefined) this.sessions.delete(candidate[0])
  }

  private async createSession(options: GenerateOptions): Promise<ProviderSession> {
    this.evictIdleSession()
    const bindings = dynamicToolBindings(options)
    const tools = bindings.map(binding => binding.definition)
    const system = [
      options.system ?? '',
      'You are the language model inside DeepSeek Harness. DeepSeek Harness owns the agent loop and tool execution.',
      'Use only the supplied dynamic tools. Never call built-in Codex tools.',
    ].filter(Boolean).join('\n\n')
    const threadId = await this.server.startThread({
      model: options.model,
      cwd: process.cwd(),
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
      baseInstructions: system,
      dynamicTools: tools,
    })
    return {
      threadId,
      toolFingerprint: dynamicToolFingerprint(bindings),
      toolNames: new Map(bindings.map(binding => [binding.wireName, binding.dshName])),
      pendingTools: [],
      backlog: [],
      touchedAt: Date.now(),
      busy: false,
    }
  }

  private async getSession(options: GenerateOptions): Promise<{ session: ProviderSession; created: boolean }> {
    const key = sessionKey(options)
    let session = this.sessions.get(key)
    const created = session === undefined
    if (session === undefined) {
      session = await this.createSession(options)
      this.sessions.set(key, session)
    }
    if (session.toolFingerprint !== dynamicToolFingerprint(dynamicToolBindings(options))) {
      throw new LlmError(
        'Dynamic tool schemas changed during an active DeepSeek Harness session.',
        'UNSUPPORTED_OPTION',
      )
    }
    session.touchedAt = Date.now()
    return { session, created }
  }

  private resumeDynamicTools(session: ProviderSession, options: GenerateOptions): void {
    const results = toolResults(options)
    for (const call of session.pendingTools) {
      const result = results.get(call.callId)
      if (result === undefined) {
        throw new LlmError(`Missing DeepSeek Harness result for tool call "${call.callId}".`, 'INVALID_REQUEST')
      }
      this.server.respond(call.requestId, {
        contentItems: [{ type: 'inputText', text: contentText(result.content) || '(no output)' }],
        success: result.isError !== true,
      })
    }
    session.pendingTools = []
  }

  private nextEvent(session: ProviderSession, signal?: AbortSignal): Promise<AppServerEvent> {
    const queued = session.backlog.shift()
    return queued === undefined
      ? this.server.nextEvent(session.threadId, signal)
      : Promise.resolve(queued)
  }

  private async collectToolBurst(
    session: ProviderSession,
    first: AppServerEvent,
    signal?: AbortSignal,
  ): Promise<PendingToolCall[]> {
    const calls: PendingToolCall[] = []
    const add = (event: AppServerEvent): void => {
      const callId = event.params.callId
      const tool = event.params.tool
      if (event.requestId === undefined || typeof callId !== 'string' || typeof tool !== 'string') {
        throw new LlmError('Codex emitted a malformed dynamic-tool request.', 'PROTOCOL_ERROR')
      }
      const dshName = session.toolNames.get(tool)
      if (dshName === undefined) {
        throw new LlmError(`Codex requested an unknown dynamic tool "${tool}".`, 'PROTOCOL_ERROR')
      }
      calls.push({
        requestId: event.requestId,
        callId,
        name: dshName,
        arguments: event.params.arguments,
      })
    }
    add(first)

    // App Server emits parallel dynamic-tool requests as one synchronous JSON-RPC
    // burst and currently has no explicit batch-end notification.
    while (true) {
      const settle = AbortSignal.timeout(25)
      const combined = signal === undefined ? settle : AbortSignal.any([signal, settle])
      try {
        const event = await this.server.nextEvent(session.threadId, combined)
        if (event.method === 'item/tool/call') add(event)
        else session.backlog.push(event)
      } catch (error) {
        if (signal?.aborted === true) throw error
        break
      }
    }
    return calls
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined || options.temperature !== undefined || options.maxTokens !== undefined) {
      throw new LlmError(
        'Codex App Server does not expose stop, temperature, or maxTokens per turn.',
        'UNSUPPORTED_OPTION',
      )
    }
    if (options.messages.some(message => message.content.some(block => block.type === 'image'))) {
      throw new LlmError('Image translation for Codex App Server is not implemented.', 'UNSUPPORTED_CONTENT')
    }

    const { session, created } = await this.getSession(options)
    if (session.busy) {
      throw new LlmError('A Codex turn is already active for this DSH session.', 'INVALID_REQUEST')
    }
    session.busy = true

    let nextIndex = 0
    const openBlocks = new Map<string, { index: number; type: 'text' | 'reasoning'; text: string }>()
    const closeOpenBlocks = (): StreamChunk[] => {
      const chunks: StreamChunk[] = []
      for (const block of openBlocks.values()) {
        chunks.push({
          type: 'block-end',
          index: block.index,
          block: block.type === 'text'
            ? { type: 'text', text: block.text }
            : { type: 'reasoning', text: block.text },
        })
      }
      openBlocks.clear()
      return chunks
    }

    try {
      if (session.pendingTools.length > 0) {
        this.resumeDynamicTools(session, options)
      } else {
        const currentText = created
          ? restoredConversation(options) ?? textSinceLastAssistant(options)
          : textSinceLastAssistant(options)
        session.turnId = await this.server.startTurn(session.threadId, {
          model: options.model,
          ...(options.reasoningEffort === undefined ? {} : { effort: String(options.reasoningEffort) }),
          input: [{ type: 'text', text: currentText || '(continue)' }],
        })
      }

      while (true) {
        const event = await this.nextEvent(session, options.signal)

        if (event.method === 'turn/started') {
          const turn = event.params.turn as JsonObject | undefined
          if (typeof turn?.id === 'string') session.turnId = turn.id
          continue
        }

        if (event.method === 'item/agentMessage/delta' || event.method === 'item/reasoning/summaryTextDelta') {
          const itemId = String(event.params.itemId ?? '')
          const blockType = event.method === 'item/agentMessage/delta' ? 'text' : 'reasoning'
          let block = openBlocks.get(itemId)
          if (block === undefined) {
            block = { index: nextIndex++, type: blockType, text: '' }
            openBlocks.set(itemId, block)
            yield { type: 'block-start', index: block.index, blockType }
          }
          const delta = String(event.params.delta ?? '')
          block.text += delta
          yield blockType === 'text'
            ? { type: 'text-delta', index: block.index, text: delta }
            : { type: 'reasoning-delta', index: block.index, text: delta }
          continue
        }

        if (event.method === 'item/completed') {
          const item = threadItem(event)
          const id = typeof item?.id === 'string' ? item.id : ''
          const block = openBlocks.get(id)
          if (block !== undefined) {
            openBlocks.delete(id)
            yield {
              type: 'block-end',
              index: block.index,
              block: block.type === 'text'
                ? { type: 'text', text: block.text }
                : { type: 'reasoning', text: block.text },
            }
          }
          continue
        }

        if (event.method === 'item/tool/call') {
          for (const chunk of closeOpenBlocks()) yield chunk
          const calls = await this.collectToolBurst(session, event, options.signal)
          session.pendingTools = calls
          for (const call of calls) {
            const index = nextIndex++
            const id = CallId(call.callId)
            const argumentsJson = toolArguments(call.arguments)
            yield { type: 'block-start', index, blockType: 'tool-call' }
            yield {
              type: 'tool-call-delta',
              index,
              id,
              name: call.name,
              argumentsDelta: argumentsJson,
            }
            yield {
              type: 'block-end',
              index,
              block: { type: 'tool-call', id, name: call.name, arguments: argumentsJson },
            }
          }
          yield {
            type: 'finish',
            reason: { kind: 'tool-calls' },
            replayState: {
              response: { kind: REPLAY_KIND, version: 1, threadId: session.threadId },
            },
          }
          return
        }

        if (event.method === 'error') {
          const detail = event.params.error as JsonObject | undefined
          throw new LlmError(String(detail?.message ?? 'Codex turn failed.'), 'CODEX_ERROR')
        }

        if (event.method === 'turn/completed') {
          for (const chunk of closeOpenBlocks()) yield chunk
          const turn = event.params.turn as JsonObject | undefined
          if (turn?.status === 'failed') {
            const detail = turn.error as JsonObject | undefined
            throw new LlmError(String(detail?.message ?? 'Codex turn failed.'), 'CODEX_ERROR')
          }
          yield {
            type: 'finish',
            reason: turn?.status === 'interrupted'
              ? { kind: 'aborted', failure: { message: 'Codex turn was interrupted.', code: 'ABORTED' } }
              : { kind: 'stop' },
            replayState: {
              response: { kind: REPLAY_KIND, version: 1, threadId: session.threadId },
            },
          }
          return
        }
      }
    } catch (error) {
      if (options.signal?.aborted === true && session.turnId !== undefined) {
        await this.server.interrupt(session.threadId, session.turnId).catch(() => {})
      }
      throw error
    } finally {
      session.busy = false
      session.touchedAt = Date.now()
    }
  }
}

export function apply(ctx: Context): void {
  const server = new AppServer()
  const adapter = new CodexAppServerAdapter(server)
  ctx.llm.registerAdapter([CODEX_PROVIDER_ID], adapter)
  ctx.effect(() => () => server.close(), 'llm-codex-app-server.close')

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register(oauthRoute(server)),
      'llm-codex-app-server.oauth-route',
    )
  })
}

export default { name, inject, apply }
