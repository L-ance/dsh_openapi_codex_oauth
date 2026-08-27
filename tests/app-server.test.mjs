import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

test('initializes Codex App Server in its isolated home', async (context) => {
  let codexBinary = process.env.DSH_CODEX_BINARY
  if (!codexBinary) {
    try {
      const candidates = execFileSync('which', ['-a', 'codex'], { encoding: 'utf8' })
        .split('\n')
        .map(value => value.trim())
        .filter(Boolean)
      // npm prepends node_modules/.bin; that wrapper intentionally lacks its
      // optional native package in this development install.
      codexBinary = candidates.find(value => !value.includes('/node_modules/.bin/'))
      if (!codexBinary) throw new Error('No native Codex binary found')
    } catch {
      context.skip('No native Codex binary is available for the integration smoke test')
      return
    }
  }
  const root = await mkdtemp(join(tmpdir(), 'dsh-openapi-app-server-'))
  const appServerModule = resolve('lib/app-server.js')
  const script = [
    `const { AppServer } = await import(${JSON.stringify(appServerModule)});`,
    'const server = new AppServer();',
    'await server.start();',
    'server.close();',
  ].join('\n')

  try {
    const { stderr } = await execFileAsync(
      process.execPath,
      ['--input-type=module', '--eval', script],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DSH_CODEX_HOME: join(root, 'codex-home'),
          DSH_CODEX_BINARY: codexBinary,
        },
        timeout: 20_000,
      },
    )
    assert.doesNotMatch(stderr, /panic|invalid configuration/i)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
