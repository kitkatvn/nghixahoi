import {WELCOME_WORDS} from './welcome-words.mjs';

const PLATFORM_CHROME = {
  darwin: {
    id: 'darwin',
    marker: 'macos',
    chromeClass: 'title-bar',
  },
  win32: {
    id: 'win32',
    marker: 'windows',
    chromeClass: 'title-bar',
  },
  linux: {
    id: 'linux',
    marker: 'linux',
    chromeClass: 'title-bar',
  },
};

const PLATFORM_ALIASES = {
  darwin: 'darwin',
  macos: 'darwin',
  mac: 'darwin',
  win32: 'win32',
  windows: 'win32',
  win: 'win32',
  linux: 'linux',
};

export function normalizeSetupPlatform(value) {
  if (value == null || value === '') {
    return null;
  }
  return PLATFORM_ALIASES[String(value).trim().toLowerCase()] ?? null;
}

export function resolveSetupPlatform(platform = process.platform) {
  return normalizeSetupPlatform(platform) ?? 'linux';
}

export function setupPlatformTheme(platform) {
  return PLATFORM_CHROME[resolveSetupPlatform(platform)];
}

// Welcome's title bar, in Welcome's words (src/welcome-words.mjs); the Mini has its own (src/companion-controls.mjs).
export function renderPlatformChrome(theme = setupPlatformTheme()) {
  return `<div class="${theme.chromeClass}" title="${WELCOME_WORDS.chrome.drag}">
    <button class="dot filled dot-close" id="closeButton" type="button" aria-label="${WELCOME_WORDS.chrome.closeName}" title="${WELCOME_WORDS.chrome.close}"></button>
    <span class="dot" aria-hidden="true"></span>
    <span class="dot" aria-hidden="true"></span>
  </div>`;
}
