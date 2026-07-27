// src/main/qbo/dev-cli.ts
//
// DEVELOPMENT ONLY. A tiny command line over the QuickBooks connection so a developer (or an agent
// with no browser) can put the app into a fully connected state, verify it against the live sandbox,
// and get the rotated refresh token back out again.
//
// WHY THIS EXISTS. The real connect flow needs a human to click "Authorize" in a browser. Every
// downstream feature (reconciliation, the review grid, posting) needs a connected app to develop
// against. Without a seeding path, each of those would have to be built blind or behind a mock, and
// the first time anything touched the real API would be the day it shipped.
//
// THE ROTATION PROTOCOL, AND WHY IT IS THE MOST IMPORTANT PART OF THIS FILE. Intuit rotates the
// refresh token on every refresh and kills the old one. The shared credentials file is the only copy
// anyone else has. So a refresh performed by this app silently invalidates the file, and the next
// person to seed from it gets a dead token with no clue why. Both directions are therefore
// explicit:
//   seed    file  -> keychain
//   export  keychain -> file   (run this after anything that may have refreshed)
//   probe   refresh + verify + sync, then export automatically
// The exporter re-reads the file immediately before writing so it preserves fields it does not own.
//
// EVERY GUARD, EVERY TIME. Nothing here runs unless app.isPackaged is false. The whole module is
// dead code in a shipped installer, and the flags below are ignored there.
//
// NOTHING PRINTS A SECRET. Tokens and client secrets are reported as a length and a short prefix at
// most, never in full. That rule is what makes it safe to run this in a terminal an agent captures.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fetchCompanyName } from './client'
import { getRealmId, getStatus, markConnected, setLastSyncAt } from './connection'
import { getQboEnvironment } from './environment'
import { syncReference } from './reference'
import {
  clearTokenSet,
  readTokenSet,
  refreshTokenSet,
  writeClientCredentials,
  writeTokenSet,
  needsRefresh,
  type TokenSet
} from './tokens'

/** The dev commands this module understands. */
export type DevQboCommand = 'seed' | 'probe' | 'export' | 'status' | 'reset'

/** Shape of .credentials/qbo-tokens.json. Extra keys are preserved on write. */
interface TokenFile {
  realmId?: string
  access_token?: string
  refresh_token?: string
  obtained_at?: string
  expires_at?: string
  [key: string]: unknown
}

/**
 * Map argv to a command, or null when no dev flag is present.
 *
 * --dev-seed-qbo is spelled out separately from the --dev-qbo-* family because it is the one an
 * onboarding note tells somebody to run, and it should read like a sentence.
 */
export function parseDevQboCommand(argv: readonly string[]): DevQboCommand | null {
  for (const arg of argv) {
    const flag = arg.split('=')[0]
    if (flag === '--dev-seed-qbo') return 'seed'
    if (flag === '--dev-qbo-probe') return 'probe'
    if (flag === '--dev-qbo-export') return 'export'
    if (flag === '--dev-qbo-status') return 'status'
    if (flag === '--dev-qbo-reset') return 'reset'
  }
  return null
}

/** Read an inline `--flag=value` override, if one was given. */
function argValue(argv: readonly string[], flag: string): string | null {
  for (const arg of argv) {
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1)
  }
  return null
}

/**
 * Locate the .credentials directory.
 *
 * Resolution order: an explicit --dev-seed-qbo=<dir>, then NICOLEBOOKS_CREDENTIALS_DIR, then an
 * upward walk from the app path and the working directory. The walk is what makes this work from a
 * git worktree, which has no .credentials of its own but sits several levels below the checkout
 * that does. Nothing is hardcoded, because this repository is public and an absolute path would
 * embed a machine and a user name in it.
 */
export function findCredentialsDir(
  argv: readonly string[],
  startDirs: readonly string[]
): string | null {
  const explicit = argValue(argv, '--dev-seed-qbo') ?? process.env['NICOLEBOOKS_CREDENTIALS_DIR']
  if (explicit) {
    const candidate = resolve(explicit)
    return existsSync(join(candidate, 'qbo-tokens.json')) ? candidate : null
  }

  for (const start of startDirs) {
    let dir = resolve(start)
    for (let depth = 0; depth < 12; depth += 1) {
      const candidate = join(dir, '.credentials')
      if (existsSync(join(candidate, 'qbo-tokens.json'))) return candidate
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return null
}

/**
 * Pull the Intuit development client id and secret out of the credentials note.
 *
 * The file is a human-maintained markdown form, so the parse is deliberately forgiving about
 * surrounding punctuation and strict about the label.
 */
export function parseClientCredentials(markdown: string): { clientId: string; clientSecret: string } | null {
  const id = /Client ID \(Development\):\s*(\S+)/i.exec(markdown)?.[1]
  const secret = /Client Secret \(Development\):\s*(\S+)/i.exec(markdown)?.[1]
  if (!id || !secret) return null
  return { clientId: id, clientSecret: secret }
}

/** Never print a credential. Report enough to tell two values apart and nothing more. */
export function redact(value: string | null | undefined): string {
  if (!value) return 'absent'
  return `present (${value.length} chars, ends ...${value.slice(-4)})`
}

function readTokenFile(path: string): TokenFile {
  return JSON.parse(readFileSync(path, 'utf8')) as TokenFile
}

/**
 * Write the current token set back to the shared file, preserving every field this app does not
 * own. The file is re-read immediately before the write so a concurrent edit is merged rather than
 * clobbered, which is the same re-read-then-write discipline the refresh itself follows.
 */
export function exportTokensToFile(path: string, tokens: TokenSet, realmId: string | null): void {
  const existing = existsSync(path) ? readTokenFile(path) : {}
  const next: TokenFile = {
    ...existing,
    realmId: realmId ?? existing.realmId,
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    obtained_at: new Date().toISOString(),
    expires_at: new Date(tokens.expiresAt).toISOString()
  }
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
}

/** Everything a command needs, resolved once. */
interface DevContext {
  credentialsDir: string
  tokenFilePath: string
}

function resolveContext(argv: readonly string[], startDirs: readonly string[]): DevContext {
  const credentialsDir = findCredentialsDir(argv, startDirs)
  if (!credentialsDir) {
    throw new Error(
      'Could not find a .credentials directory. Pass --dev-seed-qbo=<dir> or set NICOLEBOOKS_CREDENTIALS_DIR.'
    )
  }
  return { credentialsDir, tokenFilePath: join(credentialsDir, 'qbo-tokens.json') }
}

/** file -> keychain. Seeds client credentials, tokens, and the realm id. */
function commandSeed(ctx: DevContext): void {
  const notePath = join(ctx.credentialsDir, 'CREDENTIALS.md')
  const credentials = existsSync(notePath)
    ? parseClientCredentials(readFileSync(notePath, 'utf8'))
    : null
  if (!credentials) {
    throw new Error('CREDENTIALS.md did not contain a development client id and client secret.')
  }

  const file = readTokenFile(ctx.tokenFilePath)
  if (!file.refresh_token || !file.realmId) {
    throw new Error('qbo-tokens.json is missing refresh_token or realmId.')
  }

  writeClientCredentials(credentials)

  // The stored access token is assumed already expired unless the file says otherwise, so the first
  // real request refreshes rather than trusting a timestamp nobody maintained. An expiry in the
  // past is the safe default: it costs one refresh, and a wrong optimistic expiry costs a 401.
  const obtainedAt = file.obtained_at ? Date.parse(file.obtained_at) : Number.NaN
  const expiresAt = Number.isFinite(obtainedAt) ? obtainedAt + 3600 * 1000 : 0
  writeTokenSet({
    accessToken: file.access_token ?? '',
    refreshToken: file.refresh_token,
    expiresAt
  })

  markConnected({ realmId: file.realmId, companyName: null })

  process.stdout.write(
    [
      'dev-seed-qbo: seeded from ' + ctx.credentialsDir,
      `  client id      ${redact(credentials.clientId)}`,
      `  client secret  ${redact(credentials.clientSecret)}`,
      `  refresh token  ${redact(file.refresh_token)}`,
      `  access token   ${redact(file.access_token)}`,
      `  realm id       ${file.realmId}`,
      `  access expiry  ${expiresAt ? new Date(expiresAt).toISOString() : 'treated as expired'}`,
      ''
    ].join('\n')
  )
}

/** keychain -> file. Run after anything that may have rotated the refresh token. */
function commandExport(ctx: DevContext): void {
  const tokens = readTokenSet()
  if (!tokens) throw new Error('No QuickBooks tokens are stored, so there is nothing to export.')
  exportTokensToFile(ctx.tokenFilePath, tokens, getRealmId())
  process.stdout.write(
    [
      'dev-qbo-export: wrote the current tokens back to ' + ctx.tokenFilePath,
      `  refresh token  ${redact(tokens.refreshToken)}`,
      `  access token   ${redact(tokens.accessToken)}`,
      `  expires at     ${new Date(tokens.expiresAt).toISOString()}`,
      ''
    ].join('\n')
  )
}

/** Report what is stored, without revealing any of it. */
function commandStatus(): void {
  const status = getStatus()
  const tokens = readTokenSet()
  process.stdout.write(
    [
      'dev-qbo-status',
      `  environment    ${getQboEnvironment()}`,
      `  state          ${status.state}`,
      `  company        ${status.companyName ?? '(unknown)'}`,
      `  realm id       ${status.realmId ?? '(none)'}`,
      `  last sync      ${status.lastSyncAt ?? '(never)'}`,
      `  refresh token  ${redact(tokens?.refreshToken)}`,
      ''
    ].join('\n')
  )
}

/** Forget the seeded connection. Client credentials stay, exactly like a real disconnect. */
function commandReset(): void {
  clearTokenSet()
  process.stdout.write('dev-qbo-reset: cleared the stored QuickBooks tokens.\n')
}

/**
 * The live proof: refresh if needed, read CompanyInfo, run a full reference sync, print the counts,
 * and export the (possibly rotated) tokens back to the shared file.
 */
async function commandProbe(ctx: DevContext): Promise<void> {
  const before = readTokenSet()
  if (!before) throw new Error('Nothing is connected. Run --dev-seed-qbo first.')

  // Read the stored environment ONCE and pass it to every call below, exactly like the service
  // layer does. Letting each call fall back to the module default would make this probe report
  // sandbox health for a connection that is actually pointed at a live company.
  const environment = getQboEnvironment()

  const willRefresh = needsRefresh(before, Date.now())
  const tokens = willRefresh ? await refreshTokenSet({ environment }) : before
  const rotated = tokens.refreshToken !== before.refreshToken

  const realmId = getRealmId()
  if (!realmId) throw new Error('No realm id is stored. Run --dev-seed-qbo first.')

  const companyName = await fetchCompanyName(realmId, { environment })
  if (companyName) markConnected({ realmId, companyName })

  const result = await syncReference(realmId, { environment })
  setLastSyncAt(result.syncedAt)

  // Rotation protocol: the file is stale the moment a refresh succeeds, so it is updated here and
  // not left for somebody to remember.
  exportTokensToFile(ctx.tokenFilePath, tokens, realmId)

  process.stdout.write(
    [
      'dev-qbo-probe: live verification',
      `  environment      ${environment}`,
      `  refreshed        ${willRefresh ? 'yes' : 'no (access token still fresh)'}`,
      `  token rotated    ${rotated ? 'yes, written back to qbo-tokens.json' : 'no'}`,
      `  refresh token    ${redact(tokens.refreshToken)}`,
      `  realm id         ${realmId}`,
      `  company name     ${companyName ?? '(none returned)'}`,
      `  vendors          ${result.vendors}`,
      `  expense accounts ${result.expenseAccounts}`,
      `  payment accounts ${result.paymentAccounts}`,
      `  items            ${result.items}`,
      `  synced at        ${result.syncedAt}`,
      ''
    ].join('\n')
  )
}

/**
 * Run one dev command. The caller is responsible for the app.isPackaged guard; this function is
 * never reached in a packaged build.
 */
export async function runDevQboCommand(
  command: DevQboCommand,
  argv: readonly string[],
  startDirs: readonly string[]
): Promise<void> {
  const ctx = resolveContext(argv, startDirs)
  switch (command) {
    case 'seed':
      return commandSeed(ctx)
    case 'export':
      return commandExport(ctx)
    case 'status':
      return commandStatus()
    case 'reset':
      return commandReset()
    case 'probe':
      return commandProbe(ctx)
  }
}
