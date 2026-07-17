// Builds the single hardened BrowserWindow. Kept separate from lifecycle (main.mjs) so future
// tools (Aligner, Editor) reuse identical window hardening. The window is just a locked-down
// Chromium CLIENT of the loopback server — it needs no Node access (the backend IS the HTTP
// server), so we keep contextIsolation on, nodeIntegration off, sandbox on.
import { BrowserWindow } from 'electron'

export function createMainWindow(url, { appLabel = 'Brainana' } = {}) {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: appLabel,
    backgroundColor: '#0b0d10', // avoid a white flash before the SPA paints
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // Show only once the first paint is ready (no blank/white window on slow first load).
  win.once('ready-to-show', () => win.show())
  win.loadURL(url)
  return win
}
