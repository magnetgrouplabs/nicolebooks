// test/qbo-dev-cli.test.ts
//
// Coverage for the development bootstrap's pure helpers: flag parsing, credential extraction,
// redaction, the upward .credentials walk, and the token-file exporter.
//
// THE EXPORTER TEST IS THE IMPORTANT ONE. Intuit rotates the refresh token and kills the one that
// was sent, so the shared credentials file is stale the moment this app refreshes. If the exporter
// dropped a field, or wrote a partial file, the next person to seed from it would get a broken or
// dead credential with no clue why. So the merge is pinned: unknown keys survive, and the three
// values this app owns are replaced.
//
// The redaction test is the second: this CLI runs in terminals that get captured, so nothing it
// prints may be a usable credential.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  exportTokensToFile,
  findCredentialsDir,
  parseAiCredentials,
  parseClientCredentials,
  parseDevQboCommand,
  redact
} from '../src/main/qbo/dev-cli'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nb-devcli-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  delete process.env['NICOLEBOOKS_CREDENTIALS_DIR']
})

describe('parseDevQboCommand', () => {
  it('recognizes each flag', () => {
    expect(parseDevQboCommand(['electron', '.', '--dev-seed-qbo'])).toBe('seed')
    expect(parseDevQboCommand(['--dev-seed-ai'])).toBe('seed-ai')
    expect(parseDevQboCommand(['--dev-qbo-probe'])).toBe('probe')
    expect(parseDevQboCommand(['--dev-qbo-export'])).toBe('export')
    expect(parseDevQboCommand(['--dev-qbo-status'])).toBe('status')
    expect(parseDevQboCommand(['--dev-qbo-reset'])).toBe('reset')
  })

  it('accepts an inline directory override', () => {
    expect(parseDevQboCommand(['--dev-seed-qbo=/somewhere/.credentials'])).toBe('seed')
  })

  it('returns null for an ordinary launch, so the app opens its window as usual', () => {
    expect(parseDevQboCommand(['electron', '.'])).toBeNull()
    expect(parseDevQboCommand([])).toBeNull()
    // A near-miss must not trigger a credential write.
    expect(parseDevQboCommand(['--dev-seed-qbo-please'])).toBeNull()
  })
})

describe('parseClientCredentials', () => {
  it('pulls the development pair out of the credentials note', () => {
    const markdown = [
      '## 1. QuickBooks',
      '- Client ID (Development): ABqUf65aKcrFRI9Ja5Zky42xYEWAyPZP7N4RNznnZ7nfjHxYsW',
      '- Client Secret (Development): r2Ga0W7Yxsu2XJ4az6ocDLSbF1a8uV8s0Ne77XaV',
      '- Redirect URI added in portal (y/n):y'
    ].join('\n')

    expect(parseClientCredentials(markdown)).toEqual({
      clientId: 'ABqUf65aKcrFRI9Ja5Zky42xYEWAyPZP7N4RNznnZ7nfjHxYsW',
      clientSecret: 'r2Ga0W7Yxsu2XJ4az6ocDLSbF1a8uV8s0Ne77XaV'
    })
  })

  it('returns null when either half is missing, rather than seeding half a credential', () => {
    expect(parseClientCredentials('- Client ID (Development): abc')).toBeNull()
    expect(parseClientCredentials('nothing useful here')).toBeNull()
  })
})

describe('parseAiCredentials', () => {
  // The note is a human-maintained form whose labels carry parenthetical examples, and those
  // examples contain colons. A pattern that stopped at the first colon on the line would capture
  // the example rather than the answer, which is the whole reason this has a spec.
  const NOTE = [
    '## 2. AI (OpenAI-compatible, used for live parse testing)',
    '',
    '- Base URL (e.g. https://api.openai.com/v1 or https://openrouter.ai/api/v1): https://api.openai.com/v1',
    '- API key: sk-proj-abcdefghijklmnop',
    '- Vision-capable model to default to (e.g. gpt-4o): gpt-4o mini'
  ].join('\n')

  it('reads past the example URLs in the label to the value the human typed', () => {
    expect(parseAiCredentials(NOTE)?.baseUrl).toBe('https://api.openai.com/v1')
  })

  it('reads the key verbatim', () => {
    expect(parseAiCredentials(NOTE)?.apiKey).toBe('sk-proj-abcdefghijklmnop')
  })

  // A person writes "gpt-4o mini"; the API wants "gpt-4o-mini". Case is left alone on purpose,
  // because provider-qualified ids are case sensitive on some endpoints.
  it('collapses the spaces a human leaves in a model name into the id the API expects', () => {
    expect(parseAiCredentials(NOTE)?.model).toBe('gpt-4o-mini')
    expect(parseAiCredentials(NOTE.replace('gpt-4o mini', 'gpt-4o'))?.model).toBe('gpt-4o')
    expect(
      parseAiCredentials(NOTE.replace('gpt-4o mini', 'openai/gpt-4o-mini'))?.model
    ).toBe('openai/gpt-4o-mini')
  })

  it('returns null when any of the three is missing, rather than seeding a half configuration', () => {
    expect(parseAiCredentials(NOTE.replace('- API key: sk-proj-abcdefghijklmnop', ''))).toBeNull()
    expect(parseAiCredentials('nothing useful here')).toBeNull()
  })
})

describe('redact', () => {
  it('reports a length and a short suffix, never the value', () => {
    const token = 'RT1-241-H0-17939066914jax91h9f5e5hltesu4t'
    const reported = redact(token)
    expect(reported).toContain('41 chars')
    expect(reported).toContain('su4t')
    expect(reported).not.toContain(token)
    expect(reported).not.toContain('17939066914')
  })

  it('says absent rather than printing an empty string', () => {
    expect(redact(null)).toBe('absent')
    expect(redact(undefined)).toBe('absent')
    expect(redact('')).toBe('absent')
  })
})

describe('findCredentialsDir', () => {
  it('walks upward, which is what makes this work from a git worktree', () => {
    // A worktree sits several levels below the checkout that holds .credentials, and has none of
    // its own. Hardcoding an absolute path instead would embed a machine and a user name in a
    // public repository.
    const credentials = join(root, '.credentials')
    mkdirSync(credentials, { recursive: true })
    writeFileSync(join(credentials, 'qbo-tokens.json'), '{}')
    const deep = join(root, '.claude', 'worktrees', 'agent-abc')
    mkdirSync(deep, { recursive: true })

    expect(findCredentialsDir([], [deep])).toBe(credentials)
  })

  it('prefers an explicit --dev-seed-qbo=<dir>', () => {
    const explicit = join(root, 'elsewhere')
    mkdirSync(explicit, { recursive: true })
    writeFileSync(join(explicit, 'qbo-tokens.json'), '{}')

    expect(findCredentialsDir([`--dev-seed-qbo=${explicit}`], [root])).toBe(explicit)
  })

  it('reads NICOLEBOOKS_CREDENTIALS_DIR when no flag value is given', () => {
    const fromEnv = join(root, 'from-env')
    mkdirSync(fromEnv, { recursive: true })
    writeFileSync(join(fromEnv, 'qbo-tokens.json'), '{}')
    process.env['NICOLEBOOKS_CREDENTIALS_DIR'] = fromEnv

    expect(findCredentialsDir([], [root])).toBe(fromEnv)
  })

  it('returns null when there is nothing to find', () => {
    expect(findCredentialsDir([], [root])).toBeNull()
  })

  it('returns null when an explicit directory has no token file', () => {
    expect(findCredentialsDir([`--dev-seed-qbo=${root}`], [root])).toBeNull()
  })
})

describe('exportTokensToFile implements the rotation protocol', () => {
  it('replaces the values this app owns and preserves every field it does not', () => {
    const path = join(root, 'qbo-tokens.json')
    writeFileSync(
      path,
      JSON.stringify({
        realmId: '9341457604445280',
        access_token: 'old-access',
        refresh_token: 'old-refresh',
        obtained_at: '2026-07-27T19:24:48.774Z',
        note: 'Test tokens from credential validation.'
      })
    )

    exportTokensToFile(
      path,
      { accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: Date.parse('2026-07-27T21:17:06.291Z') },
      '9341457604445280'
    )

    const written = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>
    expect(written.refresh_token).toBe('new-refresh')
    expect(written.access_token).toBe('new-access')
    expect(written.expires_at).toBe('2026-07-27T21:17:06.291Z')
    // A field this app does not own must survive: losing the note would lose the only explanation
    // anyone has of what the file is.
    expect(written.note).toBe('Test tokens from credential validation.')
    expect(written.realmId).toBe('9341457604445280')
    expect(written.obtained_at).not.toBe('2026-07-27T19:24:48.774Z')
  })

  it('keeps the existing realm id when none is supplied', () => {
    const path = join(root, 'qbo-tokens.json')
    writeFileSync(path, JSON.stringify({ realmId: '9341457604445280', refresh_token: 'r' }))

    exportTokensToFile(path, { accessToken: 'a', refreshToken: 'r2', expiresAt: 0 }, null)

    const written = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>
    expect(written.realmId).toBe('9341457604445280')
  })

  it('creates the file when it does not exist yet', () => {
    const path = join(root, 'fresh.json')
    exportTokensToFile(path, { accessToken: 'a', refreshToken: 'r', expiresAt: 0 }, '123')

    const written = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>
    expect(written).toMatchObject({ realmId: '123', access_token: 'a', refresh_token: 'r' })
  })

  it('writes valid JSON with a trailing newline, so a human can read and edit it', () => {
    const path = join(root, 'qbo-tokens.json')
    exportTokensToFile(path, { accessToken: 'a', refreshToken: 'r', expiresAt: 0 }, '123')

    const text = readFileSync(path, 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    expect(() => JSON.parse(text)).not.toThrow()
  })
})
