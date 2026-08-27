import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('installer registers standard and existing DSH profiles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-openapi-installer-'))
  const bin = join(root, 'bin')
  const log = join(root, 'npx.log')
  await mkdir(join(root, 'dsh', 'profiles', 'custom'), { recursive: true })
  await mkdir(join(root, 'dsh', 'profiles', 'custom', 'node_modules'), { recursive: true })
  await mkdir(bin)
  await writeFile(join(root, 'dsh', 'profiles', 'custom', 'package.json'), '{"dependencies":{}}')
  await writeFile(
    join(root, 'dsh', 'profiles', 'custom', 'node_modules', '.modules.yaml'),
    'packageManager: "pnpm@11.8.1"\n',
  )
  const npx = join(bin, 'npx')
  await writeFile(npx, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_NPX_LOG"\n')
  await chmod(npx, 0o755)

  const result = spawnSync(process.execPath, ['lib/installer.js', 'install'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DSH_HOME: join(root, 'dsh'),
      FAKE_NPX_LOG: log,
      PATH: `${bin}:${process.env.PATH}`,
    },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  const calls = (await readFile(log, 'utf8')).trim().split('\n')
  assert.equal(calls.length, 3)
  assert(calls.some(line => line.includes(' --profile web add ')))
  assert(calls.some(line => line.includes(' --profile headless add ')))
  assert(calls.some(line => line.includes(' --profile custom add ')))
  assert(calls.every(line => line.includes('pnpm dlx @deepseek-ai/dsh@0.1.1-rc.2 plugin')))
  assert(calls.some(line => line.includes('--package=pnpm@11.8.1 pnpm dlx')))
  assert(calls.filter(line => !line.includes('--profile custom')).every(line => line.includes('--package=pnpm@11.7.0')))
  assert(calls.every(line => line.includes(
    'add https://github.com/L-ance/dsh_openapi_codex_oauth/releases/download/v0.2.0/dsh-openapi-codex-oauth-0.2.0.tgz',
  )))
})

test('local installation can target one explicit profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-openapi-local-'))
  const bin = join(root, 'bin')
  const log = join(root, 'npx.log')
  await mkdir(bin)
  const npx = join(bin, 'npx')
  await writeFile(npx, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_NPX_LOG"\n')
  await chmod(npx, 0o755)

  const result = spawnSync(process.execPath, [
    'lib/installer.js', 'install', '--local', '--profile', 'web',
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DSH_HOME: join(root, 'dsh'),
      FAKE_NPX_LOG: log,
      PATH: `${bin}:${process.env.PATH}`,
    },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  const call = (await readFile(log, 'utf8')).trim()
  assert.match(call, /--package=pnpm@11\.7\.0 pnpm dlx @deepseek-ai\/dsh@0\.1\.1-rc\.2 plugin/)
  assert.match(call, /--profile web add/)
  assert.doesNotMatch(call, /--profile headless/)
  assert.match(call, /add \/.*dsh_openapi_codex_oauth$/)
})
