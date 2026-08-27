import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import test from 'node:test'
import { codexCommand } from '../lib/codex-command.js'
import { codexHome } from '../lib/paths.js'

test('uses an isolated Codex home and resolves an explicit override', () => {
  const previous = process.env.DSH_CODEX_HOME
  try {
    delete process.env.DSH_CODEX_HOME
    assert.equal(codexHome(), join(homedir(), '.deepseek-harness', 'codex-app-server'))
    process.env.DSH_CODEX_HOME = './custom-codex-home'
    assert.equal(codexHome(), resolve('custom-codex-home'))
  } finally {
    if (previous === undefined) delete process.env.DSH_CODEX_HOME
    else process.env.DSH_CODEX_HOME = previous
  }
})

test('resolves the native Codex package for the current platform', () => {
  const previous = process.env.DSH_CODEX_BINARY
  try {
    delete process.env.DSH_CODEX_BINARY
    const executable = codexCommand(import.meta.url)
    assert.equal(executable.prefix.length, 0)
    assert.equal(basename(executable.command), process.platform === 'win32' ? 'codex.exe' : 'codex')
    assert(executable.command.includes(`@openai/codex-${process.platform}-${process.arch}`))
  } finally {
    if (previous === undefined) delete process.env.DSH_CODEX_BINARY
    else process.env.DSH_CODEX_BINARY = previous
  }
})
