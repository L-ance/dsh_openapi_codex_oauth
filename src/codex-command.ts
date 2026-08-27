import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

export interface CodexCommand {
  command: string
  prefix: string[]
}

const TARGETS: Record<string, string> = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'win32-x64': 'x86_64-pc-windows-msvc',
}

/** Prefer an explicit native binary; otherwise resolve the installed platform package. */
export function codexCommand(importMetaUrl: string): CodexCommand {
  const configured = process.env.DSH_CODEX_BINARY?.trim()
  if (configured) return { command: resolve(configured), prefix: [] }

  const platform = `${process.platform}-${process.arch}`
  const target = TARGETS[platform]
  if (target === undefined) throw new Error(`Unsupported Codex platform: ${platform}`)

  const require = createRequire(importMetaUrl)
  const packageJson = require.resolve(`@openai/codex-${platform}/package.json`)
  return {
    command: join(
      dirname(packageJson),
      'vendor',
      target,
      'bin',
      process.platform === 'win32' ? 'codex.exe' : 'codex',
    ),
    prefix: [],
  }
}
