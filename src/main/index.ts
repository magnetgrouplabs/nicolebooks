import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { getDatabase } from './db/connection'
import { migrate } from './db/migrate'
import { registerIpc } from './ipc/register'

// Dev vs packaged: electron-vite injects ELECTRON_RENDERER_URL during `electron-vite dev`.
const rendererDevUrl = process.env['ELECTRON_RENDERER_URL']

// Taskbar / window icon. Without this Electron shows its own default binary icon, which is what
// shipped until now. build/ is the electron-builder convention, so the same two files will be
// picked up automatically for the installers in Phase 8 (icon.ico on Windows, icon.png elsewhere).
// The source artwork is portrait 477x557, so it was padded to a centered square rather than
// stretched: a non-square icon gets squashed by the shell.
const windowIcon = join(
  app.getAppPath(),
  'build',
  process.platform === 'win32' ? 'icon.ico' : 'icon.png'
)

function createWindow(): void {
  // Single hardened BrowserWindow (RESEARCH Pattern 2, threat T-01-01).
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    show: false,
    icon: windowIcon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true, // renderer cannot reach main globals
      sandbox: true, // renderer runs in an OS sandbox
      nodeIntegration: false, // never expose Node to the renderer
      webSecurity: true // keep same-origin protections on
    }
  })

  win.once('ready-to-show', () => win.show())

  // Block all in-app navigation and new windows (nothing external in Phase 1, threat T-01-07).
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())

  if (rendererDevUrl) {
    win.loadURL(rendererDevUrl)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Single-instance lock: a second launch focuses the existing window instead of opening another.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows()
    if (existing) {
      if (existing.isMinimized()) existing.restore()
      existing.focus()
    }
  })

  app.whenReady().then(() => {
    // Open the SQLite connection and apply the forward-only migrations before the window
    // loads, so app_settings exists on first run when the renderer's settings round trip
    // fires. getDatabase opens userData/app.db and migrate applies pending schema changes
    // (idempotent). This runs after app 'ready' because app.getPath needs the app initialized.
    const db = getDatabase()
    migrate(db)

    createWindow()

    // Register every IPC handler after the window exists and the app is ready, so safeStorage
    // and the handlers initialize post-ready (RESEARCH Pitfall 3). The renderer's window.api
    // now reaches live, sender-validated, Zod-gated handlers.
    registerIpc()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
