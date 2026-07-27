import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { getDatabase } from './db/connection'
import { migrate } from './db/migrate'
import { installE2EHooks } from './integration/e2e-hooks'
import { installPostingBridge } from './integration/posting-bridge'
import { registerIpc } from './ipc/register'
import { parseDevQboCommand, runDevQboCommand } from './qbo/dev-cli'
import { initAutoUpdater } from './updater'

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

function createWindow(): BrowserWindow {
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

  return win
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

    // Introduce the posting engine to the live QuickBooks connection. Registration only: no
    // database read, no network call, and no token access happens here, so it is safe before a
    // company has ever been connected and before the dev bootstrap below has seeded one. Until
    // this ran, every send mapped to "connect on the Settings screen" no matter what was stored.
    installPostingBridge()

    // Development-only QuickBooks bootstrap (--dev-seed-qbo and friends). It runs after the
    // database and safeStorage are ready, prints a redacted report, and exits WITHOUT creating a
    // window, so it never leaves a stray app running. Guarded on app.isPackaged, so the flags are
    // inert in a shipped installer. See src/main/qbo/dev-cli.ts for the rotation protocol.
    const devQboCommand = app.isPackaged ? null : parseDevQboCommand(process.argv)
    if (devQboCommand) {
      runDevQboCommand(devQboCommand, process.argv, [app.getAppPath(), process.cwd()])
        .catch((err: unknown) => {
          process.exitCode = 1
          process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
        })
        .finally(() => app.quit())
      return
    }

    const win = createWindow()

    // Auto-update against the public GitHub release feed. No-op unless app.isPackaged, so
    // dev runs and the Playwright e2e suite never touch the network (see ./updater).
    initAutoUpdater(win)

    // Register every IPC handler after the window exists and the app is ready, so safeStorage
    // and the handlers initialize post-ready (RESEARCH Pitfall 3). The renderer's window.api
    // now reaches live, sender-validated, Zod-gated handlers.
    registerIpc()

    // Read-only verification hooks for the live sandbox drill. Inert unless BOTH app.isPackaged is
    // false and NICOLEBOOKS_E2E=1 is set, so a shipped installer has no such surface at all.
    installE2EHooks()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
