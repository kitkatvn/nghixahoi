import {ICON_PATH} from './app-identity.mjs';

// The Mini's window options for Electron (src/companion-electron.mjs), kept apart from Electron so a test can read them.
// `roundedCorners: false`: macOS rounds a frameless window's corners itself, over whatever the page draws, so the Mini's
// square red frame (companion-window.mjs) needs it too (the operator, 2026-10-03). Other platforms ignore it.
export function miniWindowOptions({width, height, position, preload}) {
  return {
    icon: ICON_PATH,
    width, height,
    minWidth: width, minHeight: height, maxWidth: width, maxHeight: height,
    x: position.x, y: position.y, frame: false, transparent: true, hasShadow: false, roundedCorners: false,
    backgroundColor: '#00000000', resizable: false,
    movable: true, alwaysOnTop: true, skipTaskbar: true, show: false,
    webPreferences: {preload, contextIsolation: true, nodeIntegration: false, sandbox: true},
  };
}
