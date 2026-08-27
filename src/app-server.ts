import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { codexCommand } from './codex-command.js'
import { codexHome } from './paths.js'

export type JsonObject = Record<string, unknown>

export interface AppServerEvent {
  method: string
  params: JsonObject
  requestId?: string | number
}

interface QueueWaiter {
  resolve: (value: AppServerEvent) => void
  reject: (error: Error) => void
  cleanup: () => void
}

class EventQueue {
  private readonly values: AppServerEvent[] = []
  private readonly waiters: QueueWaiter[] = []

  push(value: AppServerEvent): void {
    const waiter = this.waiters.shift()
    if (waiter === undefined) {
      this.values.push(value)
      return
    }
    waiter.cleanup()
    waiter.resolve(value)
  }

  fail(error: Error): void {
    this.values.length = 0
    for (const waiter of this.waiters.splice(0)) {
      waiter.cleanup()
      waiter.reject(error)
    }
  }

  take(signal?: AbortSignal): Promise<AppServerEvent> {
    const value = this.values.shift()
    if (value !== undefined) return Promise.resolve(value)

    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(asError(signal?.reason, 'Codex event wait was aborted'))
      }
      const waiter: QueueWaiter = {
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      }
      if (signal?.aborted === true) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }
}

interface PendingRequest {
  resolve: (value: JsonObject) => void
  reject: (error: Error) => void
}

export interface CodexAppServerApi {
  readonly accountRevision: number
  account(refreshToken?: boolean): Promise<JsonObject | null>
  models(): Promise<JsonObject[]>
  rateLimits(): Promise<JsonObject>
  startBrowserLogin(): Promise<JsonObject>
  startDeviceLogin(): Promise<JsonObject>
  logout(): Promise<void>
  startThread(input: JsonObject): Promise<string>
  startTurn(threadId: string, input: JsonObject): Promise<string>
  nextEvent(threadId: string, signal?: AbortSignal): Promise<AppServerEvent>
  respond(id: string | number, result: JsonObject): void
  interrupt(threadId: string, turnId: string): Promise<void>
  close(): void
}

function asError(value: unknown, fallback: string): Error {
  if (value instanceof Error) return value
  if (typeof value === 'string' && value.length > 0) return new Error(value)
  return new Error(fallback)
}

function appServerArguments(): string[] {
  const disabledFeatures = [
    'shell_tool',
    'goals',
    'apps',
    'browser_use',
    'computer_use',
    'hooks',
    'image_generation',
    'in_app_browser',
    'multi_agent',
    'plugins',
    'skill_search',
    'tool_suggest',
    'unified_exec',
    'workspace_dependencies',
  ]
  return [
    ...disabledFeatures.flatMap(feature => ['-c', `features.${feature}=false`]),
    '-c', 'web_search="disabled"',
    '-c', 'agents.enabled=false',
    '-c', 'tools.view_image=false',
    '-c', 'project_doc_max_bytes=0',
    'app-server',
    '--stdio',
  ]
}

export class AppServer implements CodexAppServerApi {
  private child: ChildProcessWithoutNullStreams | undefined
  private nextRequestId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly queues = new Map<string, EventQueue>()
  private readonly turnThreads = new Map<string, string>()
  private starting: Promise<void> | undefined
  accountRevision = 0

  async start(): Promise<void> {
    if (this.starting !== undefined) return this.starting
    this.starting = this.startInner().catch((error: unknown) => {
      this.starting = undefined
      throw error
    })
    return this.starting
  }

  private async startInner(): Promise<void> {
    const home = codexHome()
    await mkdir(home, { recursive: true, mode: 0o700 })

    const executable = codexCommand(import.meta.url)
    const child = spawn(executable.command, [...executable.prefix, ...appServerArguments()], {
      cwd: home,
      env: { ...process.env, CODEX_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child

    createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        this.receive(JSON.parse(line) as JsonObject)
      } catch (error) {
        this.failProtocol(asError(error, 'Codex app-server emitted invalid JSON'))
      }
    })
    child.stderr.on('data', chunk => process.stderr.write(chunk))
    child.once('error', error => this.failProtocol(error))
    child.once('exit', (code, signal) => {
      const detail = signal === null ? `code ${String(code)}` : `signal ${signal}`
      this.failProtocol(new Error(`Codex app-server exited with ${detail}`))
      this.child = undefined
      this.starting = undefined
    })

    await this.request('initialize', {
      clientInfo: {
        name: 'deepseek_harness',
        title: 'DeepSeek Harness',
        version: '0.2.1',
      },
      capabilities: { experimentalApi: true },
    })
    this.send({ method: 'initialized', params: {} })
  }

  private failProtocol(error: Error): void {
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
    for (const queue of this.queues.values()) queue.fail(error)
  }

  private send(message: JsonObject): void {
    if (this.child === undefined || this.child.stdin.destroyed) {
      throw new Error('Codex app-server is not running')
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private receive(message: JsonObject): void {
    const id = message.id
    if (typeof id === 'number' && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(id)
      if (pending === undefined) return
      this.pending.delete(id)
      if (message.error !== undefined) {
        pending.reject(new Error(`Codex app-server error: ${JSON.stringify(message.error)}`))
      } else {
        pending.resolve((message.result ?? {}) as JsonObject)
      }
      return
    }

    const method = message.method
    const params = message.params
    if (typeof method !== 'string' || params === null || typeof params !== 'object') return
    const typedParams = params as JsonObject
    if (method === 'account/updated') this.accountRevision += 1

    const threadId = typeof typedParams.threadId === 'string'
      ? typedParams.threadId
      : this.threadIdFromTurn(typedParams.turn)
    if (threadId === undefined) return

    if (id !== undefined) {
      if (method !== 'item/tool/call') {
        this.send({
          id,
          error: { code: -32601, message: `Unsupported app-server request: ${method}` },
        })
        return
      }
      this.queue(threadId).push({ method, params: typedParams, requestId: id as string | number })
      return
    }
    this.queue(threadId).push({ method, params: typedParams })
  }

  private threadIdFromTurn(turn: unknown): string | undefined {
    if (turn === null || typeof turn !== 'object') return undefined
    const turnId = (turn as JsonObject).id
    return typeof turnId === 'string' ? this.turnThreads.get(turnId) : undefined
  }

  private queue(threadId: string): EventQueue {
    let queue = this.queues.get(threadId)
    if (queue === undefined) {
      queue = new EventQueue()
      this.queues.set(threadId, queue)
    }
    return queue
  }

  async request(method: string, params: JsonObject = {}): Promise<JsonObject> {
    if (method !== 'initialize') await this.start()
    const id = this.nextRequestId++
    const result = new Promise<JsonObject>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    try {
      this.send({ id, method, params })
    } catch (error) {
      this.pending.delete(id)
      throw error
    }
    return result
  }

  async account(refreshToken = true): Promise<JsonObject | null> {
    const result = await this.request('account/read', { refreshToken })
    return (result.account ?? null) as JsonObject | null
  }

  startBrowserLogin(): Promise<JsonObject> {
    return this.request('account/login/start', {
      type: 'chatgpt',
      useHostedLoginSuccessPage: true,
      appBrand: 'chatgpt',
    })
  }

  startDeviceLogin(): Promise<JsonObject> {
    return this.request('account/login/start', { type: 'chatgptDeviceCode' })
  }

  async logout(): Promise<void> {
    await this.request('account/logout')
    this.accountRevision += 1
  }

  async models(): Promise<JsonObject[]> {
    const result = await this.request('model/list')
    return Array.isArray(result.data) ? result.data as JsonObject[] : []
  }

  rateLimits(): Promise<JsonObject> {
    return this.request('account/rateLimits/read')
  }

  async startThread(input: JsonObject): Promise<string> {
    const result = await this.request('thread/start', input)
    const thread = result.thread as JsonObject | undefined
    if (typeof thread?.id !== 'string') throw new Error('Codex thread/start returned no thread id')
    this.queue(thread.id)
    return thread.id
  }

  async startTurn(threadId: string, input: JsonObject): Promise<string> {
    const result = await this.request('turn/start', { threadId, ...input })
    const turn = result.turn as JsonObject | undefined
    if (typeof turn?.id !== 'string') throw new Error('Codex turn/start returned no turn id')
    this.turnThreads.set(turn.id, threadId)
    return turn.id
  }

  nextEvent(threadId: string, signal?: AbortSignal): Promise<AppServerEvent> {
    return this.queue(threadId).take(signal)
  }

  respond(id: string | number, result: JsonObject): void {
    this.send({ id, result })
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.request('turn/interrupt', { threadId, turnId })
  }

  close(): void {
    this.child?.kill()
  }
}
