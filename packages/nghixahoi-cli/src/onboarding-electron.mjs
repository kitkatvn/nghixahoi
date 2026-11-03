import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {app, BrowserWindow, dialog, ipcMain, nativeTheme} from 'electron';
import {ICON_PATH, nameApp, showAppIcon} from './app-identity.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describeProjects, listProjectRecords, registerNewProjects, removeProject, resolveInitialProjectSuggestion} from './runtime.mjs';
import {diagnosticsEnabled, readInvitedEmail, setInvitedEmail} from './diagnostics.mjs';
import {DASHBOARD_URL} from './integration-spec.mjs';
import {onboardingPreferences, saveOnboardingPreferences, STORE_DIR} from './store.mjs';
import {recordedTrackerPort} from './tracker-instance.mjs';
import {resolveSetupPlatform} from './onboarding-platform.mjs';
import {renderOnboardingWindow} from './onboarding-window.mjs';
import {WELCOME_ERRORS, WELCOME_TESTER_ERRORS, WELCOME_WORDS} from './welcome-words.mjs';
import {keepWindowOnItsPage} from './window-guards.mjs';

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = path.join(sourceDirectory, 'onboarding-preload.cjs');
const cliEntry = process.env.NGHIXAHOI_CLI_ENTRY;
const companionEntry = path.join(sourceDirectory, 'companion-electron.mjs');
const host = process.env.NGHIXAHOI_HOST ?? '127.0.0.1';
// A port given (`nghixahoi setup --port`), or none: the tracker then takes the first free of 4747 to 4751, and the Mini opens where
// it did (src/tracker-ports.mjs).
const port = process.env.NGHIXAHOI_PORT;
let window;
let pendingFocus = false;
const gotSingleInstanceLock = app.requestSingleInstanceLock();

function focusSetupWindow(platform) {
  if (!window || window.isDestroyed()) {
    return;
  }
  if (window.isMinimized()) {
    window.restore();
  }
  if (platform === 'darwin') {
    app.dock?.show();
  }
  window.show();
  window.focus();
}

if (!gotSingleInstanceLock) {
  app.quit();
  process.exit(0);
} else {
  app.on('second-instance', () => {
    if (window && !window.isDestroyed()) {
      focusSetupWindow(resolveSetupPlatform());
    } else {
      pendingFocus = true;
    }
  });
}

function validFolders(folders) {
  return [...new Set((Array.isArray(folders) ? folders : []).map((folder) => path.resolve(String(folder))))]
    .filter((folder) => {
      try { return fs.statSync(folder).isDirectory(); } catch { return false; }
    });
}

function runCli(args) {
  return new Promise((resolve) => {
    if (!cliEntry) return resolve(false);
    const child = spawn(process.env.NGHIXAHOI_NODE_PATH ?? process.execPath, [cliEntry, ...args], {
      detached: true,
      env: {
        ...process.env,
        NGHIXAHOI_NO_OPEN: '1',
        NO_COLOR: process.env.NO_COLOR ?? '1',
      },
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
    child.unref();
  });
}

function openCompanion() {
  const child = spawn(process.execPath, [companionEntry], {
    detached: true, stdio: 'ignore',
    env: {
      ...process.env,
      NGHIXAHOI_HOST: host,
      NGHIXAHOI_PORT: port ?? String(recordedTrackerPort()),
      NGHIXAHOI_DASHBOARD_URL: DASHBOARD_URL,
      NGHIXAHOI_NO_OPEN: '1',
    },
    windowsHide: true,
  });
  child.unref();
}

function onboardingHtmlPath(platform) {
  const cacheDir = path.join(STORE_DIR, 'cache');
  fs.mkdirSync(cacheDir, {recursive: true});
  const htmlPath = path.join(cacheDir, 'welcome.html');
  fs.writeFileSync(htmlPath, renderOnboardingWindow(platform), 'utf8');
  return htmlPath;
}

function loadOnboardingContent(window, platform) {
  try {
    window.loadFile(onboardingHtmlPath(platform));
    return;
  } catch {
    // Fall back when local cache is unavailable.
  }

  window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderOnboardingWindow(platform))}`);
}

function initialSuggestedProjects() {
  const raw = process.env.NGHIXAHOI_INITIAL_PROJECT?.trim();
  if (!raw) {
    return [];
  }

  const project = resolveInitialProjectSuggestion(raw);
  return project ? [project] : [];
}

function setupWindowOptions(platform) {
  return {
    width: 960,
    height: 640,
    resizable: false,
    maximizable: false,
    movable: true,
    center: true,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    title: WELCOME_WORDS.windowTitle,
    webPreferences: {preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true},
  };
}

nameApp(app);

app.whenReady().then(() => {
  showAppIcon(app);
  if (!gotSingleInstanceLock) {
    return;
  }

  const platform = resolveSetupPlatform(process.env.NGHIXAHOI_SETUP_PLATFORM || process.platform);
  nativeTheme.themeSource = 'dark';
  if (platform === 'darwin') {
    app.dock?.hide();
  }
  window = new BrowserWindow({...setupWindowOptions(platform), icon: ICON_PATH});
  keepWindowOnItsPage(window);
  // Project records carry absolute paths: only Welcome's own page gets them.
  ipcMain.handle('nghixahoi:onboarding-initial-state', (event) => {
    if (event.sender !== window.webContents) return {ok: false, error: WELCOME_ERRORS.invalidRequest, projects: [], suggestedProjects: []};
    return {
      ...onboardingPreferences(),
      projects: listProjectRecords(),
      suggestedProjects: initialSuggestedProjects(),
      // A tester build's: the email the tester gave before, if any (src/diagnostics.mjs).
      ...(diagnosticsEnabled() ? {invitedEmail: readInvitedEmail()} : {}),
    };
  });
  ipcMain.handle('nghixahoi:onboarding-select-folders', async (event) => {
    if (event.sender !== window.webContents) return {canceled: true, paths: []};
    const result = await dialog.showOpenDialog({properties: ['openDirectory', 'multiSelections', 'createDirectory']});
    const paths = validFolders(result.filePaths);
    return {canceled: result.canceled, paths, projects: describeProjects(paths)};
  });
  ipcMain.handle('nghixahoi:onboarding-submit', async (event, input) => {
    if (event.sender !== window.webContents) return {ok: false, error: WELCOME_ERRORS.invalidRequest};
    // A tester build's invited email, kept outside state.json, before anything else is saved; one that is not an address is
    // asked for again, and nothing is saved.
    if (diagnosticsEnabled() && typeof input?.invitedEmail === 'string' && !setInvitedEmail(input.invitedEmail).ok) {
      return {ok: false, error: WELCOME_TESTER_ERRORS.invalidEmail};
    }
    const folders = validFolders(input?.folders);
    if (!folders.length && !listProjectRecords().length) return {ok: false, error: WELCOME_ERRORS.noProjects};
    try { registerNewProjects(folders); } catch { return {ok: false, error: WELCOME_ERRORS.registerFailed}; }
    const selection = {autoTrack: input?.autoTrack === true, companionView: 'mini'};
    if (selection.autoTrack && !(await runCli(['track', '--host', host, ...(port ? ['--port', port] : [])]))) {
      saveOnboardingPreferences({...selection, completed: false});
      return {
        ok: false,
        error: WELCOME_ERRORS.trackerFailed,
        projects: listProjectRecords(),
      };
    }
    const preferences = saveOnboardingPreferences(selection);
    const projects = listProjectRecords();
    setTimeout(() => {
      openCompanion();
      window?.close();
    }, 450);
    return {ok: true, projects};
  });
  ipcMain.handle('nghixahoi:onboarding-remove-project', async (event, projectId) => {
    if (event.sender !== window.webContents) return {ok: false, error: WELCOME_ERRORS.invalidRequest};
    if (!projectId) return {ok: false, error: WELCOME_ERRORS.projectNotFound};
    try {
      const removed = removeProject(projectId);
      if (!removed) return {ok: false, error: WELCOME_ERRORS.projectNotFound};
      return {ok: true, projects: listProjectRecords()};
    } catch {
      return {ok: false, error: WELCOME_ERRORS.removeFailed};
    }
  });
  ipcMain.handle('nghixahoi:onboarding-close', (event) => {
    if (event.sender === window.webContents) window.close();
    return {closed: true};
  });

  let revealed = false;
  let readyToShow = false;
  let contentLoaded = false;

  function revealSetupWindow() {
    if (revealed || window.isDestroyed() || !readyToShow || !contentLoaded) {
      return;
    }
    revealed = true;
    focusSetupWindow(platform);
    pendingFocus = false;
  }

  window.webContents.on('preload-error', (_event, preloadScript, error) => {
    console.error(`Kit=Code Welcome preload failed (${preloadScript}):`, error?.message ?? error);
  });
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`Kit=Code Welcome failed to load (${code}):`, description, url);
  });
  window.once('ready-to-show', () => {
    readyToShow = true;
    revealSetupWindow();
  });
  window.webContents.once('did-finish-load', () => {
    contentLoaded = true;
    revealSetupWindow();
  });
  loadOnboardingContent(window, platform);
});

app.on('window-all-closed', () => {
  ipcMain.removeHandler('nghixahoi:onboarding-initial-state');
  ipcMain.removeHandler('nghixahoi:onboarding-select-folders');
  ipcMain.removeHandler('nghixahoi:onboarding-submit');
  ipcMain.removeHandler('nghixahoi:onboarding-remove-project');
  ipcMain.removeHandler('nghixahoi:onboarding-close');
  app.quit();
});
