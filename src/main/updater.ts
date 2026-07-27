import { app, dialog, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

// Auto-update against the public GitHub release feed configured in electron-builder.yml.
// The repository is public, so no token is embedded in the shipped binary.
//
// Three rules shape everything below:
//  1. Packaged builds only. `electron-vite dev` and the Playwright _electron e2e suite both
//     run unpackaged, so app.isPackaged is false and this module returns immediately. No
//     network call is made from a dev or test run.
//  2. Never crash. electron-updater is an EventEmitter: an unhandled 'error' event would
//     throw and take the app down. The 'error' listener plus the .catch() on the check are
//     what make an offline launch a logged warning instead of a fatal error.
//  3. Never block. The check is fire and forget. The only user-visible moment is the dialog
//     that appears after an update has already finished downloading in the background.

let initialized = false

function logUpdaterProblem(context: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error)
  // Offline, DNS failure, rate limit, or no release yet all land here. None of them are
  // actionable for the user, so they stay in the main-process log and nothing is shown.
  console.warn(`[updater] ${context}: ${detail}`)
}

export function initAutoUpdater(win: BrowserWindow): void {
  if (!app.isPackaged) return
  if (initialized) return
  initialized = true

  // Download in the background as soon as an update is found, and fall back to installing
  // on the next quit if the user chooses Later at the prompt.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('error', (error) => logUpdaterProblem('check or download failed', error))

  autoUpdater.on('update-downloaded', (info) => {
    if (win.isDestroyed()) return

    dialog
      .showMessageBox(win, {
        type: 'info',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'Update ready',
        message: `NicoleBooks ${info.version} is ready to install.`,
        detail:
          'Restarting takes a few seconds and nothing you have entered is lost. If you choose Later, the update installs automatically the next time you close the app.',
        noLink: true
      })
      .then(({ response }) => {
        if (response !== 0) return
        // Defer past the dialog callback so the window teardown happens on a clean tick.
        setImmediate(() => {
          try {
            autoUpdater.quitAndInstall()
          } catch (error) {
            logUpdaterProblem('restart to install failed', error)
          }
        })
      })
      .catch((error) => logUpdaterProblem('update prompt failed', error))
  })

  autoUpdater.checkForUpdates().catch((error) => logUpdaterProblem('update check failed', error))
}
