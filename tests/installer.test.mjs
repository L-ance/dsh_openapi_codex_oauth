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
  await mkdir(bin)
  await writeFile(join(root, 'dsh', 'profiles', 'custom', 'package.json'), '{"dependencies":{}}')
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
  assert(calls.every(line => line.includes(' add dsh-openapi-codex-oauth@0.1.0')))
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
  assert.match(call, /--profile web add/)
  assert.doesNotMatch(call, /--profile headless/)
})
