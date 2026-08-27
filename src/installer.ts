#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, parse, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codexCommand } from './codex-command.js'
import { codexHome } from './paths.js'

const PACKAGE_NAME = 'dsh-openapi-codex-oauth'
const RELEASE_BASE_URL = 'https://github.com/L-ance/dsh_openapi_codex_oauth/releases/download'
const DSH_PACKAGE = '@deepseek-ai/dsh@0.1.1-rc.2'
const DEFAULT_PNPM_VERSION = '11.7.0'
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const packageManifest = JSON.parse(
  readFileSync(join(packageRoot, 'package.json'), 'utf8'),
) as { version: string }

interface CliOptions {
  profiles: string[]
  local: boolean
  purgeAuth: boolean
}

function dshHome(): string {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

function profileManifest(profile: string): Record<string, unknown> | undefined {
  const path = join(dshHome(), 'profiles', profile, 'package.json')
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function existingProfiles(): string[] {
  const root = join(dshHome(), 'profiles')
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && profileManifest(entry.name) !== undefined)
    .map(entry => entry.name)
}

function hasPlugin(profile: string): boolean {
  const dependencies = profileManifest(profile)?.dependencies
  return dependencies !== null && typeof dependencies === 'object' && PACKAGE_NAME in dependencies
}

function releaseTarget(): string {
  const version = packageManifest.version
  return `${RELEASE_BASE_URL}/v${version}/${PACKAGE_NAME}-${version}.tgz`
}

function profilePnpmVersion(profile: string): string {
  const modulesManifest = join(dshHome(), 'profiles', profile, 'node_modules', '.modules.yaml')
  if (!existsSync(modulesManifest)) return DEFAULT_PNPM_VERSION
  try {
    const contents = readFileSync(modulesManifest, 'utf8')
    const match = contents.match(/^\s*"?packageManager"?\s*:\s*["']?pnpm@([^"'\s]+)["']?\s*$/m)
    const version = match?.[1]
    return version !== undefined && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
      ? version
      : DEFAULT_PNPM_VERSION
  } catch {
    return DEFAULT_PNPM_VERSION
  }
}

function runDsh(profile: string, command: 'add' | 'remove', target: string): boolean {
  const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const pnpmVersion = profilePnpmVersion(profile)
  const home = dshHome()
  mkdirSync(home, { recursive: true })
  console.log(`Using ${DSH_PACKAGE} with pnpm@${pnpmVersion} for profile ${profile}.`)
  const result = spawnSync(executable, [
    '--yes',
    `--package=pnpm@${pnpmVersion}`,
    'pnpm',
    'dlx',
    DSH_PACKAGE,
    'plugin',
    '--profile',
    profile,
    command,
    target,
  ], { cwd: home, stdio: 'inherit' })
  if (result.error !== undefined) {
    console.error(result.error.message)
    return false
  }
  return result.status === 0
}

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = { profiles: [], local: false, purgeAuth: false }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--local') {
      options.local = true
      continue
    }
    if (argument === '--purge-auth') {
      options.purgeAuth = true
      continue
    }
    if (argument === '--profile') {
      const profile = args[index + 1]
      if (profile === undefined || profile.startsWith('-')) usage()
      options.profiles.push(profile)
      index += 1
      continue
    }
    usage()
  }
  return options
}

function installProfiles(requested: string[]): string[] {
  return requested.length > 0
    ? [...new Set(requested)]
    : [...new Set(['web', 'headless', ...existingProfiles()])]
}

function uninstallProfiles(requested: string[]): string[] {
  const candidates = requested.length > 0 ? [...new Set(requested)] : existingProfiles()
  return candidates.filter(hasPlugin)
}

function purgeAuthentication(): boolean {
  const authHome = resolve(codexHome())
  const protectedPaths = new Set([
    parse(authHome).root,
    resolve(homedir()),
    resolve(dshHome()),
    resolve(process.cwd()),
    resolve(packageRoot),
  ])
  if (protectedPaths.has(authHome)) {
    console.error(`Refusing to purge unsafe OAuth path: ${authHome}`)
    return false
  }
  if (!existsSync(authHome)) return true

  const executable = codexCommand(import.meta.url)
  const logout = spawnSync(executable.command, [...executable.prefix, 'logout'], {
    env: { ...process.env, CODEX_HOME: authHome },
    stdio: 'inherit',
  })
  if (logout.error !== undefined || logout.status !== 0) {
    console.error('Codex logout failed; OAuth data was kept.')
    return false
  }

  rmSync(authHome, { recursive: true, force: true })
  if (!process.env.DSH_CODEX_HOME?.trim()) {
    try { rmdirSync(dirname(authHome)) } catch {}
  }
  console.log(`Removed OAuth data from ${authHome}`)
  return true
}

function usage(): never {
  console.error([
    'Usage:',
    `  ${PACKAGE_NAME} install [--profile NAME] [--local]`,
    `  ${PACKAGE_NAME} uninstall [--profile NAME] [--purge-auth]`,
  ].join('\n'))
  process.exit(2)
}

const [command, ...rawOptions] = process.argv.slice(2)
const options = parseOptions(rawOptions)

if (command === 'install') {
  if (options.purgeAuth) usage()
  const target = options.local
    ? packageRoot
    : releaseTarget()
  let ok = true
  for (const profile of installProfiles(options.profiles)) {
    ok = runDsh(profile, 'add', target) && ok
  }
  if (ok) console.log(`Installed ${PACKAGE_NAME} for the selected DeepSeek Harness profiles.`)
  else process.exitCode = 1
} else if (command === 'uninstall') {
  if (options.local) usage()
  let ok = true
  for (const profile of uninstallProfiles(options.profiles)) {
    ok = runDsh(profile, 'remove', PACKAGE_NAME) && ok
  }
  if (options.purgeAuth) ok = purgeAuthentication() && ok
  if (ok) console.log(`Removed ${PACKAGE_NAME} from the selected DeepSeek Harness profiles.`)
  else process.exitCode = 1
} else {
  usage()
}
