import {spawn} from 'node:child_process';
import {DASHBOARD_URL} from './integration-spec.mjs';

export {DASHBOARD_URL};

export function resolveDashboardUrl(url = process.env.NGHIXAHOI_DASHBOARD_URL || DASHBOARD_URL) {
  return url;
}

export function openDashboard(url = resolveDashboardUrl()) {
  const opener = process.platform === 'darwin'
    ? {command: 'open', args: [url]}
    : process.platform === 'win32'
      ? {command: 'cmd', args: ['/c', 'start', '', url]}
      : {command: 'xdg-open', args: [url]};

  try {
    const child = spawn(opener.command, opener.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });

    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
