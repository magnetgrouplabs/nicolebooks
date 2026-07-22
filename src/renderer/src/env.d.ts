/// <reference types="vite/client" />

// src/renderer/src/env.d.ts
//
// Renderer-side type augmentation for the IPC boundary. The renderer reaches main ONLY
// through window.api, whose type is derived from the preload's exported Api (which in turn
// conforms to src/shared/ipc-contract). This gives the renderer full type-safety over the
// settings/secrets/theme surface without ever importing electron or ipcRenderer.
import type { Api } from '../../preload'

declare global {
  interface Window {
    api: Api
  }
}

export {}
