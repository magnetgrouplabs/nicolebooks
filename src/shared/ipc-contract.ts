// src/shared/ipc-contract.ts
//
// Single source of truth for the IPC trust boundary (SC4). This file declares the
// channel-name string constants and the payload/return TypeScript types for every
// method the renderer may reach through window.api.
//
// IMPORTANT: types plus string constants ONLY. This file has zero runtime Electron or
// Node imports, because BOTH sides of the boundary import it: the sandbox-safe preload
// (renderer side) and the main-process handlers (main side, added in plan 01-05). Any
// Electron/Node import here would break the sandboxed preload bundle.

/**
 * The exact channel-name constants for every IPC channel. Three groups only:
 * settings (get/set), secrets (set/get/delete), and theme (get plus the main-to-renderer
 * broadcast theme:changed). Downstream plans (01-05 handlers, 01-06 renderer) import
 * these verbatim so a rename cannot silently desync the two sides of the boundary.
 */
export const Channels = {
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  secretsSet: 'secrets:set',
  secretsGet: 'secrets:get',
  secretsDelete: 'secrets:delete',
  themeGet: 'theme:get',
  themeChanged: 'theme:changed'
} as const

/** Union of every valid channel-name string. */
export type ChannelName = (typeof Channels)[keyof typeof Channels]

/** Payload for settings:set (validated by SettingsSetSchema in the main handler). */
export type SettingsSetPayload = { key: string; value: string }

/** Payload for secrets:set (validated by SecretSetSchema in the main handler). */
export type SecretSetPayload = { key: string; value: string }

/**
 * settings channel group. Plain key-value app settings (window size, last folder, and
 * so on). NO secret material ever flows here (secrets have their own encrypted channel).
 */
export interface SettingsApi {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<boolean>
}

/**
 * secrets channel group. Values are encrypted at rest by the main process (safeStorage,
 * plan 01-05). The contract layer itself carries no secret material, only channel names
 * and length bounds (threat T-01-05: accept).
 */
export interface SecretsApi {
  set(key: string, value: string): Promise<void>
  get(key: string): Promise<string | null>
  delete(key: string): Promise<void>
}

/**
 * theme channel group. get resolves the current isDark value (main reads
 * nativeTheme.shouldUseDarkColors); onChange subscribes to the theme:changed broadcast
 * and returns an unsubscribe function.
 */
export interface ThemeApi {
  get(): Promise<boolean>
  onChange(cb: (isDark: boolean) => void): () => void
}

/**
 * The complete typed surface exposed to the renderer as window.api. The preload builds
 * a concrete object conforming to this interface and re-exports its type as Api, and the
 * renderer Window augmentation derives from that preload type, so every layer traces back
 * to this one contract.
 */
export interface Api {
  settings: SettingsApi
  secrets: SecretsApi
  theme: ThemeApi
}
