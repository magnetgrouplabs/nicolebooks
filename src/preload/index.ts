// src/preload/index.ts
//
// Sandbox-safe preload bridge. This runs under sandbox: true, so it may use ONLY electron
// built-ins (contextBridge, ipcRenderer) and the shared, dependency-free ipc-contract; it
// must never require an npm package or other Node module (RESEARCH Pitfall 2). It is
// emitted as a single bundled CJS file at out/preload/index.js by electron.vite.config.ts.
//
// Security (threat T-01-02, elevation of privilege): the renderer is untrusted. We expose
// ONLY named settings/secrets/theme/ingestion/ai/parse/qbo/recon/posting/upload methods. We never
// expose ipcRenderer or a generic invoke, so renderer code cannot reach an arbitrary channel. Each
// method is a thin invoke on a named channel constant; the payload is validated in the main
// handler (plan 01-05).

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  Channels,
  type Api as IpcApi,
  type ParseProgress,
  type PostingProgress,
  type QboStatus,
  type UploadReceived
} from '../shared/ipc-contract'

// Annotated with the shared IpcApi interface so the exposed surface provably conforms to
// the one contract. `export type Api = typeof api` below re-exports that exact shape for
// the renderer Window augmentation, so every layer traces back to src/shared/ipc-contract.
const api: IpcApi = {
  settings: {
    get: (key) => ipcRenderer.invoke(Channels.settingsGet, key),
    set: (key, value) => ipcRenderer.invoke(Channels.settingsSet, { key, value })
  },
  secrets: {
    set: (key, value) => ipcRenderer.invoke(Channels.secretsSet, { key, value }),
    get: (key) => ipcRenderer.invoke(Channels.secretsGet, key),
    delete: (key) => ipcRenderer.invoke(Channels.secretsDelete, key)
  },
  theme: {
    get: () => ipcRenderer.invoke(Channels.themeGet),
    onChange: (cb) => {
      const listener = (_event: IpcRendererEvent, isDark: boolean): void => cb(isDark)
      ipcRenderer.on(Channels.themeChanged, listener)
      return () => ipcRenderer.removeListener(Channels.themeChanged, listener)
    }
  },
  ingestion: {
    resolveInbox: () => ipcRenderer.invoke(Channels.ingestionResolveInbox),
    chooseInbox: () => ipcRenderer.invoke(Channels.ingestionChooseInbox),
    scan: () => ipcRenderer.invoke(Channels.ingestionScan),
    // Finish sprint: "Add files". Zero-arity like scan — main opens the dialog and copies the
    // documents into the managed inbox, so no renderer-supplied path ever reaches fs (T-02-02).
    pickFiles: () => ipcRenderer.invoke(Channels.ingestionPickFiles)
  },
  // ai group (Phase 3). Note what is NOT here: no method takes or returns the API key or the base
  // URL. Both are written once through the existing secrets channel and read main-side when the
  // client is built, so a compromised renderer cannot read them back out (D-05, threat T-03-01).
  ai: {
    testConnection: () => ipcRenderer.invoke(Channels.aiTestConnection),
    listModels: () => ipcRenderer.invoke(Channels.aiListModels),
    setModel: (modelId) => ipcRenderer.invoke(Channels.aiSetModel, { modelId })
  },
  parse: {
    parseBatch: (files) => ipcRenderer.invoke(Channels.parseBatch, files),
    reparse: (fileHash) => ipcRenderer.invoke(Channels.parseReparse, { fileHash }),
    // Same subscribe/unsubscribe shape as theme.onChange: the caller gets a disposer, so a React
    // effect cleanup removes exactly its own listener and progress cannot leak across remounts.
    onProgress: (cb) => {
      const listener = (_event: IpcRendererEvent, progress: ParseProgress): void => cb(progress)
      ipcRenderer.on(Channels.parseProgress, listener)
      return () => ipcRenderer.removeListener(Channels.parseProgress, listener)
    }
  },
  // qbo group (finish sprint). Note what is NOT here, for the same reason as the ai group: no
  // method takes or returns the QuickBooks access token, refresh token, or client secret. The
  // OAuth browser flow and its loopback redirect are handled entirely main-side; the renderer only
  // asks for it to start and reads back connection STATE.
  qbo: {
    status: () => ipcRenderer.invoke(Channels.qboStatus),
    connect: () => ipcRenderer.invoke(Channels.qboConnect),
    disconnect: () => ipcRenderer.invoke(Channels.qboDisconnect),
    syncReference: () => ipcRenderer.invoke(Channels.qboSyncReference),
    getReference: () => ipcRenderer.invoke(Channels.qboGetReference),
    // Same subscribe/unsubscribe shape as theme.onChange: the caller gets a disposer, so a React
    // effect cleanup removes exactly its own listener.
    onStatusChanged: (cb) => {
      const listener = (_event: IpcRendererEvent, status: QboStatus): void => cb(status)
      ipcRenderer.on(Channels.qboStatusChanged, listener)
      return () => ipcRenderer.removeListener(Channels.qboStatusChanged, listener)
    }
  },
  recon: {
    match: (fileHashes) => ipcRenderer.invoke(Channels.reconMatch, { fileHashes })
  },
  posting: {
    send: (rows) => ipcRenderer.invoke(Channels.postingSend, { rows }),
    batches: () => ipcRenderer.invoke(Channels.postingBatches),
    batchDetail: (batchId) => ipcRenderer.invoke(Channels.postingBatchDetail, { batchId }),
    undoLast: () => ipcRenderer.invoke(Channels.postingUndoLast),
    summary: (batchId) => ipcRenderer.invoke(Channels.postingSummary, { batchId }),
    onProgress: (cb) => {
      const listener = (_event: IpcRendererEvent, progress: PostingProgress): void => cb(progress)
      ipcRenderer.on(Channels.postingProgress, listener)
      return () => ipcRenderer.removeListener(Channels.postingProgress, listener)
    }
  },
  upload: {
    start: () => ipcRenderer.invoke(Channels.uploadStart),
    stop: () => ipcRenderer.invoke(Channels.uploadStop),
    status: () => ipcRenderer.invoke(Channels.uploadStatus),
    onReceived: (cb) => {
      const listener = (_event: IpcRendererEvent, received: UploadReceived): void => cb(received)
      ipcRenderer.on(Channels.uploadReceived, listener)
      return () => ipcRenderer.removeListener(Channels.uploadReceived, listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

// Shared type for the renderer's Window augmentation (src/renderer/src/env.d.ts).
export type Api = typeof api
