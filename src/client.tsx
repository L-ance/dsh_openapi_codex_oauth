import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

const ENDPOINT = '/api/openai-codex-oauth'

interface ModelSummary {
  id: string
  name: string
}

interface RateLimitSummary {
  usedPercent: number | null
  resetsAt: number | null
  windowDurationMins: number | null
  reached: boolean
}

interface OAuthStatus {
  authenticated: boolean
  email?: string | null
  planType?: string | null
  models: ModelSummary[]
  rateLimit?: RateLimitSummary | null
}

interface DeviceLogin {
  verificationUrl: string
  userCode: string
}

const isChinese = typeof navigator !== 'undefined'
  && navigator.language.toLowerCase().startsWith('zh')

const copy = isChinese ? {
  title: 'OpenAI OAuth',
  intro: '通过 OpenAI 官方 Codex App Server 登录 ChatGPT。DSH 继续负责 Agent 循环和工具执行，插件不会读取或返回 OAuth token。',
  connected: '已连接',
  disconnected: '尚未连接',
  browserLogin: '浏览器登录',
  deviceLogin: '设备码登录',
  waiting: '等待授权…',
  logout: '退出登录',
  refresh: '刷新状态',
  models: '账户可用模型',
  noModels: '登录后会从 Codex 动态读取当前账户可用模型。',
  popup: '如果登录页面没有自动打开，请点击这里。',
  deviceHelp: '打开验证页面并输入设备码：',
  usage: '当前额度窗口已使用',
  resetAt: '重置时间',
} : {
  title: 'OpenAI OAuth',
  intro: 'Sign in to ChatGPT through the official Codex App Server. DSH keeps ownership of the agent loop and tools; this plugin never returns OAuth tokens.',
  connected: 'Connected',
  disconnected: 'Not connected',
  browserLogin: 'Browser sign-in',
  deviceLogin: 'Device-code sign-in',
  waiting: 'Waiting for authorization…',
  logout: 'Sign out',
  refresh: 'Refresh status',
  models: 'Models available to this account',
  noModels: 'After sign-in, available models are discovered dynamically from Codex.',
  popup: 'If the sign-in page did not open, continue here.',
  deviceHelp: 'Open the verification page and enter this code:',
  usage: 'Current limit window used',
  resetAt: 'Resets',
}

async function request<T>(path = '', method = 'GET'): Promise<T> {
  const response = await fetch(`${ENDPOINT}${path}`, {
    method,
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  })
  const body = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${String(response.status)}`)
  return body
}

function resetLabel(timestamp: number | null): string | undefined {
  if (timestamp === null) return undefined
  return new Date(timestamp * 1000).toLocaleString()
}

const styles: Record<string, CSSProperties> = {
  section: { maxWidth: 760, padding: '4px 0 32px' },
  title: { fontSize: 20, margin: '0 0 8px' },
  intro: { color: 'var(--text-secondary, #667085)', lineHeight: 1.6, margin: '0 0 20px' },
  card: { border: '1px solid var(--border-color, #d0d5dd)', borderRadius: 12, padding: 20 },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 },
  status: { display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 },
  dot: { width: 9, height: 9, borderRadius: '50%' },
  meta: { color: 'var(--text-secondary, #667085)', fontSize: 13, marginTop: 6 },
  actions: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 18 },
  button: {
    border: '1px solid var(--border-color, #b8c0cc)',
    borderRadius: 8,
    padding: '8px 12px',
    cursor: 'pointer',
    background: 'var(--surface-color, #fff)',
    color: 'inherit',
  },
  primary: { background: 'var(--primary-color, #2563eb)', borderColor: 'transparent', color: '#fff' },
  code: { display: 'inline-block', padding: '8px 12px', fontSize: 18, letterSpacing: 2, borderRadius: 8, background: 'var(--surface-muted, #f2f4f7)' },
  error: { color: '#b42318', marginTop: 12 },
  models: { marginTop: 24 },
  list: { margin: '10px 0 0', paddingLeft: 20, lineHeight: 1.8 },
}

export function OpenAiOAuthSection(_props: SettingsSectionOwnerProps): ReactNode {
  const [status, setStatus] = useState<OAuthStatus>()
  const [busy, setBusy] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [authUrl, setAuthUrl] = useState<string>()
  const [device, setDevice] = useState<DeviceLogin>()
  const [error, setError] = useState<string>()

  const refresh = useCallback(async (): Promise<OAuthStatus | undefined> => {
    try {
      const next = await request<OAuthStatus>()
      setStatus(next)
      setError(undefined)
      if (next.authenticated) {
        setWaiting(false)
        setAuthUrl(undefined)
        setDevice(undefined)
      }
      return next
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      return undefined
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    if (!waiting) return
    const timer = window.setInterval(() => { void refresh() }, 1500)
    return () => window.clearInterval(timer)
  }, [refresh, waiting])

  const browserLogin = async (): Promise<void> => {
    const popup = window.open('about:blank', '_blank')
    if (popup !== null) popup.opener = null
    setBusy(true)
    setError(undefined)
    setDevice(undefined)
    try {
      const result = await request<{ authUrl: string }>('/login/browser', 'POST')
      setAuthUrl(result.authUrl)
      setWaiting(true)
      if (popup !== null) popup.location.href = result.authUrl
    } catch (reason) {
      popup?.close()
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const deviceLogin = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    setAuthUrl(undefined)
    try {
      const result = await request<DeviceLogin>('/login/device', 'POST')
      setDevice(result)
      setWaiting(true)
      window.open(result.verificationUrl, '_blank', 'noopener,noreferrer')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const logout = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await request('/logout', 'POST')
      setWaiting(false)
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const connected = status?.authenticated === true
  const resetAt = resetLabel(status?.rateLimit?.resetsAt ?? null)
  return (
    <section style={styles.section}>
      <h2 style={styles.title}>{copy.title}</h2>
      <p style={styles.intro}>{copy.intro}</p>
      <div style={styles.card}>
        <div style={styles.row}>
          <div>
            <div style={styles.status} role="status" aria-live="polite">
              <span style={{ ...styles.dot, background: connected ? '#12b76a' : '#98a2b3' }} />
              {connected ? copy.connected : copy.disconnected}
            </div>
            {connected
              ? <div style={styles.meta}>{[status.email, status.planType].filter(Boolean).join(' · ')}</div>
              : null}
          </div>
        </div>

        {connected && status.rateLimit?.usedPercent !== null && status.rateLimit?.usedPercent !== undefined
          ? <p style={styles.meta}>
              {copy.usage}: {String(status.rateLimit.usedPercent)}%
              {resetAt === undefined ? '' : ` · ${copy.resetAt}: ${resetAt}`}
            </p>
          : null}

        <div style={styles.actions}>
          {connected
            ? <button type="button" style={styles.button} disabled={busy} onClick={() => { void logout() }}>{copy.logout}</button>
            : <>
                <button type="button" style={{ ...styles.button, ...styles.primary }} disabled={busy || waiting} onClick={() => { void browserLogin() }}>
                  {waiting ? copy.waiting : copy.browserLogin}
                </button>
                <button type="button" style={styles.button} disabled={busy || waiting} onClick={() => { void deviceLogin() }}>
                  {copy.deviceLogin}
                </button>
              </>}
          <button type="button" style={styles.button} disabled={busy} onClick={() => { void refresh() }}>{copy.refresh}</button>
        </div>

        {authUrl === undefined ? null : <p><a href={authUrl} target="_blank" rel="noreferrer">{copy.popup}</a></p>}
        {device === undefined ? null : <div>
          <p>{copy.deviceHelp}</p>
          <p><code style={styles.code}>{device.userCode}</code></p>
          <a href={device.verificationUrl} target="_blank" rel="noreferrer">{device.verificationUrl}</a>
        </div>}
        {error === undefined ? null : <p style={styles.error} role="alert">{error}</p>}

        <div style={styles.models}>
          <strong>{copy.models}</strong>
          {status?.models.length
            ? <ul style={styles.list}>{status.models.map(model => <li key={model.id}>{model.name} <code>{model.id}</code></li>)}</ul>
            : <p style={styles.meta}>{copy.noModels}</p>}
        </div>
      </div>
    </section>
  )
}

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'openai-oauth',
    order: 11,
    label: () => 'OpenAI OAuth',
  }, OpenAiOAuthSection))
}
