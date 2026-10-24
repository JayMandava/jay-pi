import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
function walk(dir) { return readdirSync(dir, { withFileTypes: true }).filter(e => e.name !== 'node_modules').flatMap(e => e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]); }
const files = ['bin', 'scripts', 'extensions', 'tests'].flatMap(walk).filter(f => /\.(mjs|ts)$/.test(f) && !f.includes('/node_modules/'));
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) { process.stderr.write(result.stderr); process.exitCode = 1; }
}
if (!process.exitCode) console.log(`Syntax checked ${files.length} JavaScript/TypeScript files.`);
