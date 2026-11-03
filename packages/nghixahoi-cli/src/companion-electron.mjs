import {app, BrowserWindow, ipcMain, nativeTheme, screen, shell} from 'electron';
import {nameApp, showAppIcon} from './app-identity.mjs';
import {miniWindowOptions} from './companion-window-options.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {reachableAddress} from './api-access.mjs';
import {renderCompanionWindow} from './companion-window.mjs';
import {resolveDashboardUrl} from './open-dashboard.mjs';
import {recordedTrackerPort} from './tracker-instance.mjs';
import {keepWindowOnItsPage} from './window-guards.mjs';

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const host = process.env.NGHIXAHOI_HOST ?? '127.0.0.1';
// The port Welcome or the CLI gave, or the one this HOME's tracker took (src/tracker-ports.mjs).
const port = process.env.NGHIXAHOI_PORT ?? String(recordedTrackerPort());
// The URL sets the Host header, and the API answers only a loopback Host (api-access.mjs).
const apiBase = `http://${reachableAddress(host)}:${port}`;
const companionPreload = path.join(sourceDirectory, 'companion-preload.cjs');
const miniWidth = 560;
const miniHeight = 76;

let miniWindow;
let quitting = false;

function miniPosition() {
  const {workArea} = screen.getPrimaryDisplay();
  return {
    x: workArea.x + workArea.width - miniWidth - 28,
    y: workArea.y + workArea.height - miniHeight - 72,
  };
}

async function trackerReady() {
  try {
    const response = await fetch(`${apiBase}/api/health`, {signal: AbortSignal.timeout(1200)});
    const health = response.ok ? await response.json() : null;
    return health?.status === 'ok' && health?.app === 'nghixahoi';
  } catch {
    return false;
  }
}

function createMiniWindow(url) {
  const position = miniPosition();
  miniWindow = new BrowserWindow(miniWindowOptions({width: miniWidth, height: miniHeight, position, preload: companionPreload}));
  keepWindowOnItsPage(miniWindow);
  miniWindow.setAlwaysOnTop(true, 'floating');
  miniWindow.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true});
  miniWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      app.quit();
    }
  });
  miniWindow.loadURL(url);
}

nameApp(app);

app.whenReady().then(async () => {
  showAppIcon(app);
  nativeTheme.themeSource = 'dark';
  const connected = await trackerReady();
  const miniUrl = connected
    ? `${apiBase}/companion`
    : `data:text/html;charset=utf-8,${encodeURIComponent(renderCompanionWindow(apiBase))}`;
  createMiniWindow(miniUrl);
  ipcMain.handle('nghixahoi:companion-hide', (event) => {
    if (event.sender === miniWindow.webContents) app.quit();
    return {hidden: true};
  });
  ipcMain.handle('nghixahoi:open-dashboard', (event) => {
    if (event.sender !== miniWindow.webContents) {
      return {opened: false};
    }

    shell.openExternal(resolveDashboardUrl());
    return {opened: true};
  });
  miniWindow.once('ready-to-show', () => miniWindow.showInactive());
});

app.on('before-quit', () => {
  quitting = true;
  ipcMain.removeHandler('nghixahoi:companion-hide');
  ipcMain.removeHandler('nghixahoi:open-dashboard');
});
