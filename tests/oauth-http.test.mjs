import assert from 'node:assert/strict'
import test from 'node:test'
import { handleOAuthRequest } from '../lib/oauth-http.js'

function response() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body = '') { this.body = body },
  }
}

const localHeaders = {
  host: '127.0.0.1:1456',
  origin: 'http://127.0.0.1:1456',
  'sec-fetch-site': 'same-origin',
}
const localSocket = { remoteAddress: '127.0.0.1' }

function fakeServer() {
  return {
    async account() { return { type: 'chatgpt', email: 'user@example.com', planType: 'pro' } },
    async models() { return [{ model: 'gpt-test-codex', displayName: 'GPT Test Codex' }] },
    async rateLimits() {
      return { rateLimits: { primary: { usedPercent: 25, resetsAt: 2_000_000_000, windowDurationMins: 300 } } }
    },
    async startBrowserLogin() { return { authUrl: 'https://chatgpt.com/login', loginId: 'browser-1' } },
    async startDeviceLogin() { return { verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234', loginId: 'device-1' } },
    async logout() {},
  }
}

test('returns account, model, and rate-limit status only to local same-origin requests', async () => {
  const ok = response()
  await handleOAuthRequest(
    fakeServer(),
    { method: 'GET', url: '/api/openai-codex-oauth', headers: localHeaders, socket: localSocket },
    ok,
  )
  assert.equal(ok.status, 200)
  assert.deepEqual(JSON.parse(ok.body), {
    authenticated: true,
    email: 'user@example.com',
    planType: 'pro',
    models: [{ id: 'gpt-test-codex', name: 'GPT Test Codex' }],
    rateLimit: { usedPercent: 25, resetsAt: 2_000_000_000, windowDurationMins: 300, reached: false },
  })

  const crossSite = response()
  await handleOAuthRequest(
    fakeServer(),
    {
      method: 'POST',
      url: '/api/openai-codex-oauth/logout',
      headers: { ...localHeaders, origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' },
      socket: localSocket,
    },
    crossSite,
  )
  assert.equal(crossSite.status, 403)

  const remote = response()
  await handleOAuthRequest(
    fakeServer(),
    { method: 'GET', url: '/api/openai-codex-oauth', headers: localHeaders, socket: { remoteAddress: '192.0.2.1' } },
    remote,
  )
  assert.equal(remote.status, 403)
})

test('starts browser/device login and logout without exposing credentials', async () => {
  const browser = response()
  await handleOAuthRequest(
    fakeServer(),
    { method: 'POST', url: '/api/openai-codex-oauth/login/browser', headers: localHeaders, socket: localSocket },
    browser,
  )
  assert.deepEqual(JSON.parse(browser.body), {
    authUrl: 'https://chatgpt.com/login',
    loginId: 'browser-1',
  })

  const device = response()
  await handleOAuthRequest(
    fakeServer(),
    { method: 'POST', url: '/api/openai-codex-oauth/login/device', headers: localHeaders, socket: localSocket },
    device,
  )
  assert.deepEqual(JSON.parse(device.body), {
    verificationUrl: 'https://auth.openai.com/codex/device',
    userCode: 'ABCD-1234',
    loginId: 'device-1',
  })
  assert.doesNotMatch(device.body, /access.?token|refresh.?token/i)
})
