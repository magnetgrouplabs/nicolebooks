// src/main/ipc/theme.ts
//
// theme:get handler plus the theme:changed broadcast (RESEARCH Pitfall 4, follow the OS).
//
// theme:get validates the sender (T-01-03) then returns nativeTheme.shouldUseDarkColors,
// the current OS dark-mode preference the renderer toggles its .dark class from. The
// nativeTheme 'updated' subscription broadcasts the new isDark boolean to every window so
// the renderer follows OS appearance changes live. The broadcast is main-initiated (not a
// response to renderer input), so there is no sender to validate on that path.

import { ipcMain, nativeTheme, BrowserWindow } from 'electron'
import { Channels } from '../../shared/ipc-contract'
import { assertTrustedSender } from './trusted-sender'

/** Register theme:get and wire the nativeTheme -> theme:changed broadcast. */
export function registerThemeIpc(): void {
  ipcMain.handle(Channels.themeGet, (event) => {
    assertTrustedSender(event)
    return nativeTheme.shouldUseDarkColors
  })

  nativeTheme.on('updated', () => {
    const isDark = nativeTheme.shouldUseDarkColors
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(Channels.themeChanged, isDark)
    }
  })
}
