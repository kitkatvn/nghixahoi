import path from 'node:path';
import {fileURLToPath} from 'node:url';

// The name and icon of Kit=Code's Electron windows, Welcome and the Mini (the operator, 2026-10-03): "Kit=Code Companion",
// and the web dashboard's favicon, rendered as a 512 × 512 PNG, which Electron reads where it cannot read an SVG.
//
// What it changes: the app's name for Electron (menus, notifications), the Dock's icon on macOS while a window is open,
// and each window's icon on Windows and Linux. What it cannot: the Dock's label on macOS, which is the running bundle's
// name, Electron's own, until Kit=Code ships an app bundle of its own.
export const APP_NAME = 'Kit=Code Companion';
export const ICON_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets', 'nghixahoi-icon.png');

// Called before the app is ready: the name. Never throws: a window opens without it.
export function nameApp(app) {
  try {
    app.setName(APP_NAME);
  } catch {
    // The name is cosmetic.
  }
}

// Called once the app is ready: the Dock's icon on macOS. Never throws.
export function showAppIcon(app) {
  try {
    app.dock?.setIcon(ICON_PATH);
  } catch {
    // The icon is cosmetic.
  }
}
