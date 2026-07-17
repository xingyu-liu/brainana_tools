// Minimal application menu, kept separate from lifecycle (main.mjs) and window hardening
// (window.mjs) so future tools reuse the same chrome. Electron auto-generates a noisy default
// menu ("File Edit View Window Help") when none is set; for a single-window viewer most of that
// is clutter. We can't just drop the menu, though — the default silently carries essential
// keyboard shortcuts (Quit, Copy/Paste, Reload, DevTools, Zoom, Fullscreen). So we build a
// curated menu from Electron *roles*: roles give correct per-platform accelerators and labels
// for free (Cmd on macOS, Ctrl elsewhere), which is exactly the set we want to preserve.
import { Menu } from 'electron'

const isMac = process.platform === 'darwin'

export function applyAppMenu(appLabel = 'Brainana') {
  const template = [
    // macOS shows a menu at the top of the screen no matter what, so give it a native app menu
    // (App name → About/Hide/Quit) instead of a broken-looking bare one. Non-macOS gets Quit
    // under File below.
    ...(isMac ? [{ label: appLabel, role: 'appMenu' }] : []),

    // Non-macOS: the only File item we need is Quit (Ctrl+Q). On macOS this lives in appMenu.
    ...(isMac ? [] : [{ label: 'File', submenu: [{ role: 'quit' }] }]),

    // Undo/Redo/Cut/Copy/Paste/Select All — required for clipboard shortcuts in text inputs.
    { role: 'editMenu' },

    // Curated View: reload + devtools for debugging the packaged app (nodeIntegration is off),
    // plus zoom and fullscreen.
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },

    { role: 'windowMenu' },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
