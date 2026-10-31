import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {writeFileAtomically} from './atomic-file.mjs';
import {
  CLI_GLOBAL_COMMAND,
  hookConfigFor,
  hookCommandFor as specHookCommandFor,
  RUNNER_DISPLAY_PATH,
  sourceConfig as integrationSourceConfig,
} from './integration-spec.mjs';
import {isLegacyHookCommand} from './legacy.mjs';
import {runnerPath} from './runner-installer.mjs';

// ~/.claude/settings.json and ~/.codex/hooks.json belong to the user (hard rule 3). Kit=Code refuses
// to write a file it cannot parse or that the user made read-only, keeps every key it did not add,
// and backs up the exact previous bytes before every write.
const NEW_CONFIG_MODE = 0o600;

export class ConfigFileError extends Error {
  constructor(filePath, problem, cause) {
    super(`${filePath} ${problem}`, {cause});
    this.name = 'ConfigFileError';
    this.filePath = filePath;
    this.problem = problem;
  }
}

function configPath(source) {
  return path.join(os.homedir(), ...integrationSourceConfig(source).hookConfigPathParts);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSymbolicLink(filePath) {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

// The file's indentation and final newline, so that a rewrite changes only Kit=Code's entry.
function formatOf(text) {
  const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? (text.includes('\n') ? 2 : 0);

  return {indent, finalNewline: text.endsWith('\n')};
}

function serializeConfig(config, format) {
  return `${JSON.stringify(config, null, format.indent)}${format.finalNewline ? '\n' : ''}`;
}

// A missing file reads as {exists: false}. Anything else Kit=Code cannot read, parse, or merge into
// throws ConfigFileError: it is never taken for an empty config.
function readConfig(filePath) {
  let stat;
  let realPath;

  try {
    stat = fs.statSync(filePath);
    realPath = fs.realpathSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT' && !isSymbolicLink(filePath)) {
      return {exists: false, filePath, realPath: filePath};
    }

    throw new ConfigFileError(filePath, error.code === 'ENOENT'
      ? 'is a symbolic link to a file that does not exist'
      : `could not be read (${error.code})`, error);
  }

  if (!stat.isFile()) {
    throw new ConfigFileError(filePath, 'is not a regular file');
  }

  let bytes;

  try {
    bytes = fs.readFileSync(realPath);
  } catch (error) {
    throw new ConfigFileError(filePath, `could not be read (${error.code})`, error);
  }

  const text = bytes.toString('utf8');
  let config;

  try {
    config = JSON.parse(text);
  } catch (error) {
    throw new ConfigFileError(filePath, `is not valid JSON (${error.message})`, error);
  }

  if (!isObject(config)) {
    throw new ConfigFileError(filePath, 'does not hold a JSON object');
  }

  if (config.hooks !== undefined && !isObject(config.hooks)) {
    throw new ConfigFileError(filePath, 'has a "hooks" value that is not an object');
  }

  if (config.hooks?.UserPromptSubmit !== undefined && !Array.isArray(config.hooks.UserPromptSubmit)) {
    throw new ConfigFileError(filePath, 'has a "hooks.UserPromptSubmit" value that is not a list');
  }

  return {exists: true, filePath, realPath, bytes, config, mode: stat.mode & 0o777, format: formatOf(text)};
}

// A file the user made read-only is theirs to change, not Kit=Code's. A rename replaces a file whatever
// its mode, as long as its folder is writable, so the file itself is asked: for a symbolic link, the
// file it points to. The mode, a lock (chflags uchg), an ACL and a read-only disk all count. Returns
// why Kit=Code may not write the file, or null.
function readOnlyRefusal(current) {
  try {
    fs.accessSync(current.realPath, fs.constants.W_OK);
    return null;
  } catch (error) {
    if (!['EACCES', 'EPERM', 'EROFS'].includes(error.code)) {
      throw error;
    }

    const problem = isSymbolicLink(current.filePath) ? `links to ${current.realPath}, which is read-only` : 'is read-only';
    return Object.assign(new ConfigFileError(current.filePath, problem, error), {readOnly: true});
  }
}

// A copy of the exact bytes Kit=Code read, with the file's own mode, next to the path the agent
// reads (not inside the folder a symbolic link points into). Never overwrites an earlier backup.
function backUp(current) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  for (let attempt = 0; ; attempt += 1) {
    const backupPath = `${current.filePath}.nghixahoi-${stamp}${attempt > 0 ? `-${attempt}` : ''}.bak`;
    let fd;

    try {
      fd = fs.openSync(backupPath, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') {
        continue;
      }

      throw error;
    }

    try {
      fs.fchmodSync(fd, current.mode);
      fs.writeFileSync(fd, current.bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    return backupPath;
  }
}

// Replaces the file with `config`: a backup of the previous bytes first, then an atomic write that
// keeps the file's mode. A new file is created 0600, with the folder it needs. A read-only file is
// refused before anything is written, its backup included.
function writeConfig(current, config) {
  const format = current.exists ? current.format : {indent: 2, finalNewline: true};
  let backupPath = null;

  if (current.exists) {
    const readOnly = readOnlyRefusal(current);

    if (readOnly) {
      throw readOnly;
    }

    // A user, or the agent itself, may have saved the file since Kit=Code read it.
    if (!fs.readFileSync(current.realPath).equals(current.bytes)) {
      throw new ConfigFileError(current.filePath, 'changed while Kit=Code was updating it; run the command again');
    }

    backupPath = backUp(current);
  } else {
    fs.mkdirSync(path.dirname(current.realPath), {recursive: true});
  }

  writeFileAtomically(current.realPath, serializeConfig(config, format), {mode: current.exists ? current.mode : NEW_CONFIG_MODE});
  return backupPath;
}

function asConfigFileError(filePath, error) {
  return error instanceof ConfigFileError
    ? error
    : new ConfigFileError(filePath, `could not be written (${error.code ?? error.message})`, error);
}

function hookCommandFor(source) {
  return specHookCommandFor(source, {runnerPath: runnerPath()});
}

function createNghixahoiHook(source) {
  return hookConfigFor(source, {runnerPath: runnerPath()});
}

// Every command this Kit=Code's hook of `source` has had: its runner's path as this platform writes it, the display form the setup
// prompts show, ~/.nghixahoi/bin/nghixahoi, the command on PATH, and the runner's path quoted for sh, which is what Kit=Code wrote on
// Windows before 2026-09-29 and which PowerShell cannot parse (docs/security.md, "The prompt hook on Windows"): `on` replaces it and
// `off` removes it. Elsewhere it is the command itself. An earlier Kit=Code's are src/legacy.mjs's, and recognised as these are, so
// that `on` replaces them and `off` and uninstall remove them.
function nghixahoiHookCommands(source) {
  return [
    specHookCommandFor(source, {runnerPath: runnerPath()}),
    specHookCommandFor(source, {runnerPath: RUNNER_DISPLAY_PATH, platform: 'linux'}),
    `${CLI_GLOBAL_COMMAND} hook prompt --source ${source}`,
    specHookCommandFor(source, {runnerPath: runnerPath(), platform: 'linux'}),
  ];
}

function isNghixahoiHook(source, hook) {
  return hook?.type === 'command' && (hook.command === hookCommandFor(source) || nghixahoiHookCommands(source).includes(hook.command) || isLegacyHookCommand(source, hook.command));
}

function hasNghixahoiHook(source, group) {
  return isObject(group) && Array.isArray(group.hooks) && group.hooks.some((hook) => isNghixahoiHook(source, hook));
}

// The Kit=Code entries in hooks.UserPromptSubmit, as they are in the file.
function nghixahoiEntries(source, config) {
  const groups = Array.isArray(config.hooks?.UserPromptSubmit) ? config.hooks.UserPromptSubmit : [];

  return groups
    .filter((group) => hasNghixahoiHook(source, group))
    .flatMap((group) => group.hooks.filter((hook) => isNghixahoiHook(source, hook)));
}

// What to add by hand when Kit=Code may not write the file itself.
export function manualHookSnippet(source) {
  return {
    hooks: {
      UserPromptSubmit: [
        {
          matcher: '',
          hooks: [createNghixahoiHook(source)],
        },
      ],
    },
  };
}

// Leaves exactly one Kit=Code entry, `entry`, in hooks.UserPromptSubmit. An existing Kit=Code entry
// is replaced where it stands; any others go, with groups that only held them. Returns whether the
// config changed.
function placeNghixahoiHook(source, config, entry) {
  const groups = Array.isArray(config.hooks?.UserPromptSubmit) ? config.hooks.UserPromptSubmit : [];
  const nextGroups = [];
  let placed = false;
  let changed = false;

  for (const group of groups) {
    if (!hasNghixahoiHook(source, group)) {
      nextGroups.push(group);
      continue;
    }

    const hooks = [];

    for (const hook of group.hooks) {
      if (!isNghixahoiHook(source, hook)) {
        hooks.push(hook);
      } else if (!placed) {
        placed = true;
        changed ||= !isDeepStrictEqual(hook, entry);
        hooks.push(entry);
      } else {
        changed = true;
      }
    }

    if (hooks.length > 0) {
      nextGroups.push({...group, hooks});
    } else {
      changed = true;
    }
  }

  if (!placed) {
    nextGroups.push({
      matcher: '',
      hooks: [entry],
    });
    changed = true;
  }

  if (changed) {
    config.hooks = {...(isObject(config.hooks) ? config.hooks : {}), UserPromptSubmit: nextGroups};
  }

  return changed;
}

// Removes every Kit=Code entry from hooks.UserPromptSubmit, and the groups and keys that removing
// them leaves empty. Returns whether there was anything to remove.
function removeNghixahoiHooks(source, config) {
  const groups = config.hooks?.UserPromptSubmit;

  if (!Array.isArray(groups) || !groups.some((group) => hasNghixahoiHook(source, group))) {
    return false;
  }

  const nextGroups = [];

  for (const group of groups) {
    if (!hasNghixahoiHook(source, group)) {
      nextGroups.push(group);
      continue;
    }

    const hooks = group.hooks.filter((hook) => !isNghixahoiHook(source, hook));

    if (hooks.length > 0) {
      nextGroups.push({...group, hooks});
    }
  }

  if (nextGroups.length > 0) {
    config.hooks.UserPromptSubmit = nextGroups;
  } else {
    delete config.hooks.UserPromptSubmit;
  }

  if (Object.keys(config.hooks).length === 0) {
    delete config.hooks;
  }

  return true;
}

export function isHookInstalled(source) {
  return hookStatus(source).installed === true;
}

// `action` is what happened: 'installed', 'unchanged' (already there), or 'refused' (the file was
// left as it is; `error` says why). Refused because the file is read-only, it also has `entries`: the
// Kit=Code entries already in the file, which the one added by hand replaces.
export function installHook(source) {
  const filePath = configPath(source);
  const command = hookCommandFor(source);
  let entries = [];

  try {
    const current = readConfig(filePath);
    const config = current.exists ? current.config : {};
    entries = nghixahoiEntries(source, config);

    if (!placeNghixahoiHook(source, config, createNghixahoiHook(source))) {
      return {installed: true, action: 'unchanged', path: filePath, command};
    }

    const backupPath = writeConfig(current, config);
    return {installed: true, action: 'installed', path: filePath, command, backupPath};
  } catch (error) {
    const refusal = asConfigFileError(filePath, error);
    return {installed: false, action: 'refused', path: filePath, command, error: refusal, ...(refusal.readOnly ? {entries} : {})};
  }
}

// An earlier Kit=Code's entry in `source`'s config replaced by this one's, where the file holds one (src/legacy.mjs), whichever
// agent `on` was run for: so that no hook runs the earlier package once one agent is moved. `action`: 'replaced', 'none' (no file,
// or no earlier entry in it; nothing was written), or 'refused' (the file was left as it is; `error` says why). The file is read,
// kept and backed up as installHook does it.
export function replaceLegacyHook(source) {
  const filePath = configPath(source);

  try {
    const current = readConfig(filePath);

    if (!current.exists || !nghixahoiEntries(source, current.config).some((hook) => isLegacyHookCommand(source, hook.command))) {
      return {action: 'none', path: filePath};
    }

    placeNghixahoiHook(source, current.config, createNghixahoiHook(source));
    const backupPath = writeConfig(current, current.config);
    return {action: 'replaced', path: filePath, backupPath};
  } catch (error) {
    return {action: 'refused', path: filePath, error: asConfigFileError(filePath, error)};
  }
}

// `action`: 'removed', 'not-found' (no file, or no Kit=Code entry in it; nothing was written), or
// 'refused' (the file was left as it is; `error` says why). Refused because the file is read-only, it
// also has `entries`: the Kit=Code entries to delete by hand.
export function uninstallHook(source) {
  const filePath = configPath(source);
  const command = hookCommandFor(source);
  let entries = [];

  try {
    const current = readConfig(filePath);
    entries = current.exists ? nghixahoiEntries(source, current.config) : [];

    if (!current.exists || !removeNghixahoiHooks(source, current.config)) {
      return {installed: false, action: 'not-found', path: filePath, command};
    }

    const backupPath = writeConfig(current, current.config);
    return {installed: false, action: 'removed', path: filePath, command, backupPath};
  } catch (error) {
    const refusal = asConfigFileError(filePath, error);
    return {installed: null, action: 'refused', path: filePath, command, error: refusal, ...(refusal.readOnly ? {entries} : {})};
  }
}

// `installed` is null when the file cannot be read: that says nothing about the hook. A file Kit=Code
// can read but may not write also has `error`, which says why, and `entries`, the Kit=Code entries in
// it.
export function hookStatus(source) {
  const filePath = configPath(source);
  const command = hookCommandFor(source);

  try {
    const current = readConfig(filePath);
    const entries = current.exists ? nghixahoiEntries(source, current.config) : [];
    const readOnly = current.exists ? readOnlyRefusal(current) : null;

    return {installed: entries.length > 0, path: filePath, command, ...(readOnly ? {error: readOnly, entries} : {})};
  } catch (error) {
    return {installed: null, path: filePath, command, error: asConfigFileError(filePath, error)};
  }
}
