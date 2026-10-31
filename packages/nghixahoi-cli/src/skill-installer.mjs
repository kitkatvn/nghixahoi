import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {displayHomePath, nghixahoiSkillMarkdown, sourceConfig} from './integration-spec.mjs';

function skillPath(source) {
  return path.join(os.homedir(), ...sourceConfig(source).skillPathParts);
}

function writeFileAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});

  if (fs.existsSync(filePath)) {
    const backupPath = `${filePath}.nghixahoi.bak`;

    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(filePath, backupPath);
    }
  }

  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, value);
  fs.renameSync(tmpPath, filePath);
}

export function installSkill(source) {
  const filePath = skillPath(source);
  writeFileAtomic(filePath, nghixahoiSkillMarkdown(source));

  return {
    installed: true,
    path: filePath,
  };
}

export function uninstallSkill(source) {
  const filePath = skillPath(source);
  const removed = fs.existsSync(filePath);

  if (removed) {
    fs.rmSync(filePath);
  }

  return {
    installed: false,
    removed,
    path: filePath,
  };
}

export function uninstallSkillTree(source) {
  const filePath = skillPath(source);
  const skillDir = path.dirname(filePath);
  const removed = fs.existsSync(skillDir);

  if (removed) {
    fs.rmSync(skillDir, {recursive: true, force: true});
  }

  return {
    removed,
    path: skillDir,
  };
}

export function skillStatus(source) {
  const filePath = skillPath(source);

  return {
    installed: fs.existsSync(filePath),
    path: filePath,
    displayPath: displayHomePath(sourceConfig(source).skillPathParts),
  };
}

export {nghixahoiSkillMarkdown};
