import { createRequire } from 'node:module'
import { resolve } from 'node:path'

export interface CodexCommand {
  command: string
  prefix: string[]
}

/** Prefer an explicit native binary; otherwise use the platform binary bundled by @openai/codex. */
export function codexCommand(importMetaUrl: string): CodexCommand {
  const configured = process.env.DSH_CODEX_BINARY?.trim()
  if (configured) return { command: resolve(configured), prefix: [] }

  const require = createRequire(importMetaUrl)
  return {
    command: process.execPath,
    prefix: [require.resolve('@openai/codex/bin/codex.js')],
  }
}
