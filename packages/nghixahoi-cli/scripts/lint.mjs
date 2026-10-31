// The CLI's `lint`: `node --check` on bin/nghixahoi.mjs and on every src/*.mjs and src/*.cjs file,
// each in a process of its own. It replaces a POSIX shell `for` loop, which npm cannot run on
// Windows, where it runs scripts with cmd.exe. There is no linter; this is a syntax pass only.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// What the shell's `src/*.mjs` matched: the top level of src/ only, and no name starting with a dot.
function sourceFiles(extension) {
  const names = fs.readdirSync(path.join(packageRoot, 'src'))
    .filter((name) => name.endsWith(extension) && !name.startsWith('.'))
    .sort();

  // The loop failed here too: a pattern that matched nothing reached node --check as a literal name.
  if (names.length === 0) {
    console.error(`No src/*${extension} file in ${packageRoot}: nothing to check.`);
    process.exit(1);
  }

  return names.map((name) => path.join('src', name));
}

const files = [path.join('bin', 'nghixahoi.mjs'), ...sourceFiles('.mjs'), ...sourceFiles('.cjs')];
const failed = [];

for (const file of files) {
  // node --check prints the syntax error itself, with the file and line.
  const result = spawnSync(process.execPath, ['--check', file], {cwd: packageRoot, stdio: 'inherit'});

  if (result.error) {
    console.error(`${file}: node --check could not run: ${result.error.message}`);
  }

  if (result.status !== 0) {
    failed.push(file);
  }
}

if (failed.length > 0) {
  console.error(`node --check failed for ${failed.length} of ${files.length} files: ${failed.join(', ')}`);
  process.exit(1);
}

console.log(`node --check passed for ${files.length} files.`);
