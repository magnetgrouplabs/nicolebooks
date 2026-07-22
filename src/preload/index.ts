// Plan 01-01: minimal sandbox-safe preload placeholder.
//
// The typed contextBridge `api` surface (settings / secrets / theme channel groups)
// is authored in plans 01-02 and 01-05. This file is intentionally empty for now so
// electron-vite emits a valid single bundled CJS preload artifact at out/preload/index.js
// that the hardened window can load. It uses no npm requires, so it stays sandbox-safe.
export {}
