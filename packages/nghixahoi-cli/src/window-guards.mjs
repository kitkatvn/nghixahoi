// A Kit=Code window shows its own page and nothing else: it opens no other window, and it never
// navigates away, whatever the page asks. The dashboard opens in the user's browser through the
// preload bridge (companion-electron.mjs, shell.openExternal), not in a window of ours.
export function keepWindowOnItsPage(window) {
  window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
}
