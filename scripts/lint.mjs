import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { structureErrors } from './structure.mjs';

let failures = 0;
for (const directory of ['src', 'test', 'public', 'scripts']) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(ts|js|mjs|css|html)$/.test(entry.name)) continue;
    const path = `${directory}/${entry.name}`;
    const source = await readFile(path, 'utf8');
    if (directory === 'src') {
      const errors = structureErrors(path, source);
      errors.forEach(error => console.error(error));
      failures += errors.length;
    }
    for (const [index, line] of source.split('\n').entries()) {
      if (/\s+$/.test(line)) { console.error(`${path}:${index + 1}: trailing whitespace`); failures++; }
      if (/^(<{7}|={7}|>{7})/.test(line)) { console.error(`${path}:${index + 1}: conflict marker`); failures++; }
    }
    if (/\.(js|mjs)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
      if (result.status !== 0) failures++;
    }
  }
}
console.log(`Source structure, hygiene and JavaScript syntax: ${failures} errors`);
process.exitCode = failures ? 1 : 0;
