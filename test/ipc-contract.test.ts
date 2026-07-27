// test/ipc-contract.test.ts
//
// SC4 payload-validation coverage (threat T-01-03, tampering). Proves that every IPC
// payload schema accepts a representative valid payload and rejects the malformed cases
// (empty key, oversized key, oversized value, wrong type, missing field), and that the
// channel-name constants are stable strings so a rename cannot silently break the boundary.
//
// The oversized-value cases are deliberately split by ceiling (settings value max 4096 vs
// secret value max 8192): a 5000-char value must be rejected by settings but accepted by
// secrets. Removing or loosening any .max() bound therefore fails at least one assertion.

import { describe, it, expect } from 'vitest'
import {
  SettingsSetSchema,
  SettingsKeySchema,
  SecretSetSchema,
  SecretKeySchema
} from '../src/shared/schemas'
import { Channels } from '../src/shared/ipc-contract'

const keyOverMax = 'k'.repeat(129) // over the 128 key ceiling
const settingsValueOverMax = 'v'.repeat(4097) // over the 4096 settings-value ceiling
const secretValueOverMax = 'v'.repeat(8193) // over the 8192 secret-value ceiling
const midValue = 'v'.repeat(5000) // above settings ceiling, below secret ceiling

describe('SettingsSetSchema', () => {
  it('accepts a valid payload', () => {
    expect(SettingsSetSchema.parse({ key: 'theme', value: 'dark' })).toEqual({
      key: 'theme',
      value: 'dark'
    })
  })
  it('rejects an empty key', () => {
    expect(SettingsSetSchema.safeParse({ key: '', value: 'y' }).success).toBe(false)
  })
  it('rejects an oversized key', () => {
    expect(SettingsSetSchema.safeParse({ key: keyOverMax, value: 'y' }).success).toBe(false)
  })
  it('rejects an oversized value (exercises the 4096 bound)', () => {
    expect(SettingsSetSchema.safeParse({ key: 'x', value: settingsValueOverMax }).success).toBe(
      false
    )
  })
  it('rejects a value that exceeds the settings ceiling but fits the secret ceiling', () => {
    expect(SettingsSetSchema.safeParse({ key: 'x', value: midValue }).success).toBe(false)
  })
  it('rejects a non-string value', () => {
    expect(SettingsSetSchema.safeParse({ key: 'x', value: 123 }).success).toBe(false)
  })
  it('rejects a missing value field', () => {
    expect(SettingsSetSchema.safeParse({ key: 'x' }).success).toBe(false)
  })
})

describe('SettingsKeySchema', () => {
  it('accepts a valid key', () => {
    expect(SettingsKeySchema.parse('last-folder')).toBe('last-folder')
  })
  it('rejects an empty key', () => {
    expect(SettingsKeySchema.safeParse('').success).toBe(false)
  })
  it('rejects an oversized key', () => {
    expect(SettingsKeySchema.safeParse(keyOverMax).success).toBe(false)
  })
  it('rejects a non-string key', () => {
    expect(SettingsKeySchema.safeParse(123).success).toBe(false)
  })
})

describe('SecretSetSchema', () => {
  it('accepts a valid payload', () => {
    expect(SecretSetSchema.parse({ key: 'canary', value: 'ok' })).toEqual({
      key: 'canary',
      value: 'ok'
    })
  })
  it('accepts a value up to the larger secret ceiling', () => {
    expect(SecretSetSchema.safeParse({ key: 'token', value: midValue }).success).toBe(true)
  })
  it('rejects an empty key', () => {
    expect(SecretSetSchema.safeParse({ key: '', value: 'ok' }).success).toBe(false)
  })
  it('rejects an oversized key', () => {
    expect(SecretSetSchema.safeParse({ key: keyOverMax, value: 'ok' }).success).toBe(false)
  })
  it('rejects an oversized value (exercises the 8192 bound)', () => {
    expect(SecretSetSchema.safeParse({ key: 'token', value: secretValueOverMax }).success).toBe(
      false
    )
  })
  it('rejects a non-string value', () => {
    expect(SecretSetSchema.safeParse({ key: 'token', value: null }).success).toBe(false)
  })
  it('rejects a missing key field', () => {
    expect(SecretSetSchema.safeParse({ value: 'ok' }).success).toBe(false)
  })
})

describe('SecretKeySchema', () => {
  it('accepts a valid key', () => {
    expect(SecretKeySchema.parse('canary')).toBe('canary')
  })
  it('rejects an empty key', () => {
    expect(SecretKeySchema.safeParse('').success).toBe(false)
  })
  it('rejects an oversized key', () => {
    expect(SecretKeySchema.safeParse(keyOverMax).success).toBe(false)
  })
  it('rejects a non-string key', () => {
    expect(SecretKeySchema.safeParse(42).success).toBe(false)
  })
})

describe('Channels are stable strings', () => {
  it('pins every channel name so a rename does not silently break the boundary', () => {
    expect(Channels).toEqual({
      settingsGet: 'settings:get',
      settingsSet: 'settings:set',
      secretsSet: 'secrets:set',
      secretsGet: 'secrets:get',
      secretsDelete: 'secrets:delete',
      themeGet: 'theme:get',
      themeChanged: 'theme:changed',
      // Phase 2 ingestion channel group (plan 02-01).
      ingestionResolveInbox: 'ingestion:resolve-inbox',
      ingestionChooseInbox: 'ingestion:choose-inbox',
      ingestionScan: 'ingestion:scan',
      // Phase 3 ai channel group (plan 03-01): config + live model list + selected-model persistence.
      aiTestConnection: 'ai:test-connection',
      aiListModels: 'ai:list-models',
      aiSetModel: 'ai:set-model',
      // Phase 3 parse channel group (plan 03-01): batch parse + single re-parse + progress broadcast.
      parseBatch: 'parse:parse-batch',
      parseReparse: 'parse:reparse',
      parseProgress: 'parse:progress',
      // Finish-sprint groups (SEAMS). These names are a FIXED integration contract shared by four
      // agents working in parallel worktrees, so this pin is the thing that makes a rename LOUD
      // rather than silent: a channel renamed in one worktree fails here at merge instead of
      // producing a handler nobody's preload can reach.
      qboStatus: 'qbo:status',
      qboConnect: 'qbo:connect',
      qboDisconnect: 'qbo:disconnect',
      qboSyncReference: 'qbo:sync-reference',
      qboGetReference: 'qbo:get-reference',
      qboStatusChanged: 'qbo:status-changed',
      reconMatch: 'recon:match',
      postingSend: 'posting:send',
      postingProgress: 'posting:progress',
      postingBatches: 'posting:batches',
      postingBatchDetail: 'posting:batch-detail',
      postingUndoLast: 'posting:undo-last',
      postingSummary: 'posting:summary',
      // Added by REVIEW-UI (finish sprint): the review screen's prior-entry warning.
      postingCheckDuplicates: 'posting:check-duplicates',
      ingestionPickFiles: 'ingestion:pick-files',
      uploadStart: 'upload:start',
      uploadStop: 'upload:stop',
      uploadStatus: 'upload:status',
      uploadReceived: 'upload:received'
    })
  })
})
