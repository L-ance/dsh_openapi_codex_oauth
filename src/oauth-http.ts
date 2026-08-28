import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { CodexAppServerApi, JsonObject } from './app-server.js'

export const OAUTH_API_PATH = '/api/openai-codex-oauth'
const OPTIONAL_DETAILS_TIMEOUT_MS = 5_000

type OAuthServer = Pick<
  CodexAppServerApi,
  'account' | 'models' | 'rateLimits' | 'startBrowserLogin' | 'startDeviceLogin' | 'logout'
>

function isLoopback(address: string | undefined): boolean {
  if (address === undefined) return false
  if (address === '::1') return true
  const ipv4 = address.startsWith('::ffff:') ? address.slice(7) : address
  return isIP(ipv4) === 4 && ipv4.startsWith('127.')
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '')
  return normalized === 'localhost' || normalized === '::1'
    || (isIP(normalized) === 4 && normalized.startsWith('127.'))
}

/** OAuth mutations are intentionally unavailable through remote DSH web access. */
function isTrustedLocalRequest(req: IncomingMessage): boolean {
  if (!isLoopback(req.socket.remoteAddress)) return false
  const host = req.headers.host
  if (host === undefined) return false

  let authority: URL
  try {
    authority = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLocalHostname(authority.hostname)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false

  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).origin === authority.origin
  } catch {
    return false
  }
}

function respondJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

function browserAuthorizationUrl(result: JsonObject): string {
  if (typeof result.authUrl !== 'string') {
    throw new Error('Codex App Server did not return a browser authorization URL.')
  }
  const url = new URL(result.authUrl)
  if (url.protocol !== 'https:') {
    throw new Error('Codex App Server returned an insecure browser authorization URL.')
  }
  return url.href
}

async function optionalWithin<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | number | undefined
  const timeout = new Promise<undefined>(resolve => {
    timer = setTimeout(resolve, timeoutMs)
  })
  const result = Promise.resolve().then(operation).catch(() => undefined)
  try {
    return await Promise.race([result, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function rateLimitSummary(result: JsonObject | undefined): JsonObject | null {
  const limits = result?.rateLimits as JsonObject | undefined
  const primary = limits?.primary as JsonObject | undefined
  if (primary === undefined) return null
  return {
    usedPercent: typeof primary.usedPercent === 'number' ? primary.usedPercent : null,
    resetsAt: typeof primary.resetsAt === 'number' ? primary.resetsAt : null,
    windowDurationMins: typeof primary.windowDurationMins === 'number'
      ? primary.windowDurationMins
      : null,
    reached: limits?.rateLimitReachedType !== null && limits?.rateLimitReachedType !== undefined,
  }
}

export async function handleOAuthRequest(
  server: OAuthServer,
  req: IncomingMessage,
  res: ServerResponse,
  detailsTimeoutMs = OPTIONAL_DETAILS_TIMEOUT_MS,
): Promise<void> {
  if (!isTrustedLocalRequest(req)) {
    respondJson(res, 403, {
      error: 'OpenAI OAuth controls are available only from the local DeepSeek Harness UI.',
    })
    return
  }

  const path = new URL(req.url ?? '/', 'http://localhost').pathname
  try {
    if (req.method === 'GET' && path === OAUTH_API_PATH) {
      const account = await server.account(false)
      if (account?.type !== 'chatgpt') {
        respondJson(res, 200, { authenticated: false, models: [], rateLimit: null })
        return
      }
      const [models, rateLimits] = await Promise.all([
        optionalWithin(() => server.models(), detailsTimeoutMs),
        optionalWithin(() => server.rateLimits(), detailsTimeoutMs),
      ])
      respondJson(res, 200, {
        authenticated: true,
        email: typeof account.email === 'string' ? account.email : null,
        planType: typeof account.planType === 'string' ? account.planType : null,
        models: (models ?? []).filter(model => model.hidden !== true).map(model => ({
          id: String(model.model ?? model.id),
          name: String(model.displayName ?? model.model ?? model.id),
        })),
        rateLimit: rateLimitSummary(rateLimits),
      })
      return
    }

    if (req.method === 'POST' && path === `${OAUTH_API_PATH}/login/browser`) {
      const result = await server.startBrowserLogin()
      const authUrl = browserAuthorizationUrl(result)
      respondJson(res, 200, {
        authUrl,
        loginId: typeof result.loginId === 'string' ? result.loginId : null,
      })
      return
    }

    if (req.method === 'POST' && path === `${OAUTH_API_PATH}/login/browser/redirect`) {
      const result = await server.startBrowserLogin()
      const authUrl = browserAuthorizationUrl(result)
      res.writeHead(303, {
        location: authUrl,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      })
      res.end()
      return
    }

    if (req.method === 'POST' && path === `${OAUTH_API_PATH}/login/device`) {
      const result = await server.startDeviceLogin()
      if (typeof result.verificationUrl !== 'string' || typeof result.userCode !== 'string') {
        throw new Error('Codex App Server did not return a device authorization code.')
      }
      respondJson(res, 200, {
        verificationUrl: result.verificationUrl,
        userCode: result.userCode,
        loginId: typeof result.loginId === 'string' ? result.loginId : null,
      })
      return
    }

    if (req.method === 'POST' && path === `${OAUTH_API_PATH}/logout`) {
      await server.logout()
      respondJson(res, 200, { ok: true })
      return
    }

    respondJson(res, 404, { error: 'Not found' })
  } catch (error) {
    respondJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
}

export function oauthRoute(server: OAuthServer): WebRoute {
  return {
    kind: 'prefix',
    path: OAUTH_API_PATH,
    handler: (req, res) => handleOAuthRequest(server, req, res),
  }
}
