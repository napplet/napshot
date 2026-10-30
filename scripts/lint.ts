import { structureErrors } from './structure.ts';

let failures = 0;
for (const directory of ['src', 'test', 'public', 'scripts']) {
  for await (const entry of Deno.readDir(directory)) {
    if (!entry.isFile || !/\.(ts|js|css|html)$/.test(entry.name)) continue;
    const path = `${directory}/${entry.name}`;
    const source = await Deno.readTextFile(path);
    if (directory === 'src') {
      const errors = structureErrors(path, source);
      errors.forEach(error => console.error(error));
      failures += errors.length;
    }
    for (const [index, line] of source.split('\n').entries()) {
      if (/\s+$/.test(line)) { console.error(`${path}:${index + 1}: trailing whitespace`); failures++; }
      if (/^(<{7}|={7}|>{7})/.test(line)) { console.error(`${path}:${index + 1}: conflict marker`); failures++; }
    }
  }
}
console.log(`Source structure and hygiene: ${failures} errors`);
Deno.exitCode = failures ? 1 : 0;
