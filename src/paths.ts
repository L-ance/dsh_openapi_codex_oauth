import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Keep this provider's Codex state separate from a user's normal Codex CLI.
 * Codex, rather than this plugin, owns the files below this directory.
 */
export function codexHome(): string {
  const configured = process.env.DSH_CODEX_HOME?.trim()
  return configured ? resolve(configured) : join(homedir(), '.deepseek-harness', 'codex-app-server')
}
