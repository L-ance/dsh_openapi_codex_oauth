#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { codexCommand } from './codex-command.js'
import { codexHome } from './paths.js'

const executable = codexCommand(import.meta.url)
const home = codexHome()
await mkdir(home, { recursive: true, mode: 0o700 })

const child = spawn(executable.command, [...executable.prefix, 'login', ...process.argv.slice(2)], {
  env: { ...process.env, CODEX_HOME: home },
  stdio: 'inherit',
})
child.once('exit', code => { process.exitCode = code ?? 1 })
child.once('error', (error) => {
  console.error(`Failed to start Codex from ${dirname(executable.command)}: ${error.message}`)
  process.exitCode = 1
})
