// src/shared/schemas.ts
//
// Zod schemas that gate every IPC payload at the main-process handler (plan 01-05).
// A thrown parse becomes a rejected promise in the renderer, so a malformed payload
// never reaches the privileged action. These bounds ARE the T-01-03 input-validation
// control (tampering mitigation) for the IPC boundary: min/max lengths on every key and
// value. The unit suite in test/ipc-contract.test.ts proves the accept/reject behavior.
//
// Length bounds (from 01-RESEARCH Security Domain, lines 694 and 706):
//   key:            min 1, max 128   (never empty, guards oversized keys)
//   settings value: max 4096         (plain app-settings strings)
//   secret value:   max 8192         (room for tokens and API keys)

import { z } from 'zod'

/** settings:set payload. Rejects empty keys, oversized keys/values, and non-string fields. */
export const SettingsSetSchema = z.object({
  key: z.string().min(1).max(128),
  value: z.string().max(4096)
})

/** settings:get key. Bare string, never empty, bounded length. */
export const SettingsKeySchema = z.string().min(1).max(128)

/** secrets:set payload. Same key bounds as settings; a larger value ceiling for tokens. */
export const SecretSetSchema = z.object({
  key: z.string().min(1).max(128),
  value: z.string().max(8192)
})

/** secrets:get and secrets:delete key. Bare string, never empty, bounded length. */
export const SecretKeySchema = z.string().min(1).max(128)
