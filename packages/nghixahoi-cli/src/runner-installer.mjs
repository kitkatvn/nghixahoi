import fs from 'node:fs';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {writeFileAtomically} from './atomic-file.mjs';
import {CLI_INSTALL_COMMAND, CLI_PACKAGE_NAME, RUNNER_PATH_PARTS, shellQuote} from './integration-spec.mjs';

const require = createRequire(import.meta.url);

function packageRoot() {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

export function runnerPath() {
  return path.join(os.homedir(), ...RUNNER_PATH_PARTS);
}

// The fallback runs this exact version, never whatever is newest on npm.
function pinnedPackage() {
  return `${CLI_PACKAGE_NAME}@${require(path.join(packageRoot(), 'package.json')).version}`;
}

function runnerScript() {
  const node = shellQuote(process.execPath);
  const bin = shellQuote(path.join(packageRoot(), 'bin', 'nghixahoi.mjs'));
  const fallback = `npx -y ${shellQuote(pinnedPackage())}`;

  return [
    '#!/bin/sh',
    `if [ -x ${node} ] && [ -f ${bin} ]; then`,
    `  exec ${node} ${bin} "$@"`,
    'fi',
    '# The installed CLI is gone. Exit code 2 from the prompt hook blocks the prompt, so the hook',
    '# exits 0 whatever the fallback does.',
    'if [ "$1" = hook ]; then',
    `  ${fallback} "$@"`,
    '  exit 0',
    'fi',
    `exec ${fallback} "$@"`,
    '',
  ].join('\n');
}

// The runner for cmd.exe, which does what the runner does. `call`, because npx is itself a .cmd file,
// and a .cmd file run without it never returns to the one that ran it: before 2026-09-29 nothing ran
// after the fallback, and the hook's exit code was npx's. Each way out names its exit code: a bare
// `exit /b` gave cmd /c's caller 0 whatever npx returned (the second Windows run). A % in a path is
// doubled, as a .cmd file needs.
function runnerCmdScript() {
  const cmdText = (text) => text.replaceAll('%', '%%');
  const binPath = cmdText(path.join(packageRoot(), 'bin', 'nghixahoi.mjs'));
  const fallback = `call npx -y ${pinnedPackage()} %*`;

  return [
    '@echo off',
    `if exist "${binPath}" goto run`,
    'rem The installed CLI is gone. Exit code 2 from the prompt hook blocks the prompt, so the hook',
    'rem exits 0 whatever the fallback does.',
    'if /i "%~1"=="hook" goto hook',
    fallback,
    'exit /b %errorlevel%',
    ':hook',
    fallback,
    'exit /b 0',
    ':run',
    `"${cmdText(process.execPath)}" "${binPath}" %*`,
    'exit /b %errorlevel%',
    '',
  ].join('\r\n');
}

// The runner module, which the hook's command runs on Windows with the `node` on PATH
// (integration-spec.mjs, hookCommandFor). It does what the runner does: the installed CLI, with the node
// that installed it, or failing that this one; if the CLI is gone, this exact version from npm; and the
// prompt hook exits 0 whatever happens, since exit code 2 blocks the user's prompt. On Windows npx is a
// .cmd file, which only a shell runs, and cmd.exe splits and expands what it is given, so there only
// arguments it takes as they are reach the fallback. Written on every platform, so that every platform's
// tests run it.
function runnerModuleScript() {
  return [
    '// Kit=Code\'s runner module, written by `nghixahoi <agent> on` (runner-installer.mjs).',
    'import {spawnSync} from \'node:child_process\';',
    'import {existsSync} from \'node:fs\';',
    '',
    `const node = ${JSON.stringify(process.execPath)};`,
    `const bin = ${JSON.stringify(path.join(packageRoot(), 'bin', 'nghixahoi.mjs'))};`,
    `const pinned = ${JSON.stringify(pinnedPackage())};`,
    // What it says to install again with: the package at its channel's dist-tag, never a version (since 2026-10-30, as the setup
    // prompts: integration-spec.mjs, CLI_INSTALL_COMMAND). The fallback above still runs this exact version.
    `const reinstall = ${JSON.stringify(CLI_INSTALL_COMMAND)};`,
    'const args = process.argv.slice(2);',
    'const windows = process.platform === \'win32\';',
    '',
    '// With a shell, one command line and no arguments beside it, which Node would pass on unquoted.',
    'function run(command, commandArgs) {',
    '  const options = {stdio: \'inherit\', windowsHide: true};',
    '  const result = commandArgs === undefined ? spawnSync(command, {...options, shell: true}) : spawnSync(command, commandArgs, options);',
    '  return result.status ?? 1;',
    '}',
    '',
    'let status;',
    '',
    'if (existsSync(bin)) {',
    '  status = run(existsSync(node) ? node : process.execPath, [bin, ...args]);',
    '} else if (!windows) {',
    '  status = run(\'npx\', [\'-y\', pinned, ...args]);',
    '} else if (args.every((arg) => /^[\\w@./:=,+-]+$/u.test(arg))) {',
    '  status = run([\'npx\', \'-y\', pinned, ...args].join(\' \'));',
    '} else {',
    '  console.error(`Kit=Code is not installed any more. Install it again with: ${reinstall}`);',
    '  status = 1;',
    '}',
    '',
    'process.exit(args[0] === \'hook\' ? 0 : status);',
    '',
  ].join('\n');
}

// Rewrites a runner file only when its content changes, and atomically: the prompt hook may be
// reading it at that moment, and a half-written script is a shell syntax error, exit 2.
function writeRunnerFile(filePath, content, mode) {
  try {
    if (fs.readFileSync(filePath, 'utf8') === content && (fs.statSync(filePath).mode & 0o777) === mode) {
      return;
    }
  } catch {
    // Missing or unreadable: write it.
  }

  writeFileAtomically(filePath, content, {mode});
}

function writeRunner(filePath) {
  writeRunnerFile(filePath, runnerScript(), 0o755);
  writeRunnerFile(`${filePath}.cmd`, runnerCmdScript(), 0o644);
  writeRunnerFile(`${filePath}.mjs`, runnerModuleScript(), 0o644);
}

// The runner, ~/.nghixahoi/bin/nghixahoi, with its .cmd and .mjs beside it. Uninstall removes ~/.nghixahoi, and it with it.
export function installRunner() {
  const filePath = runnerPath();

  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  writeRunner(filePath);

  return {
    installed: true,
    path: filePath,
  };
}

export function runnerStatus() {
  const filePath = runnerPath();

  return {
    installed: fs.existsSync(filePath),
    path: filePath,
  };
}
