import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exec } from './helpers.js';
import { entry, packageRoot } from '../src/system.js';

test('global install replaces the old CLI, installs skills via official CLI, repairs hooks and supports skill-first onboarding', async t => {
  const home = await mkdtemp(join(tmpdir(), 'doomer-install-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const npm = join(home, 'fake-npm.mjs');
  await writeFile(npm, `
import { cp, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
const args = process.argv.slice(2);
await appendFile(join(process.env.HOME, 'calls'), JSON.stringify(args)+'\\n');
if (args[0] === 'install') {
  console.log('npm install progress');
  const root = join(args[args.indexOf('--prefix')+1], 'node_modules', '@doomerlabs', 'doomer');
  await cp(process.env.SOURCE, root, { recursive: true });
} else if (args[0] === 'exec') {
  console.log('skills install progress');
  const root = join(process.env.HOME, '.agents', 'skills', 'doomer');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'SKILL.md'), '---\\nname: doomer\\n---\\n');
} else if (args[0] === 'view') console.log('"0.1.0"');
else process.exit(1);
`);
  const bin = join(home, '.local', 'bin'); await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'doomer'), 'old doomer');
  const codex = join(home, '.codex'); await mkdir(codex);
  await writeFile(join(codex, 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo keep' }] }] }, trust: 'keep' }));
  const env = { ...process.env, HOME: home, DOOMER_HOME: join(home, 'state'), DOOMER_BIN_DIR: bin, CODEX_HOME: codex, CLAUDE_CONFIG_DIR: join(home, '.claude'), npm_execpath: npm, SOURCE: packageRoot };
  const cli = args => exec(process.execPath, [entry, ...args], { env });
  assert.equal(JSON.parse((await cli(['install', '--agent', 'codex', '--json'])).stdout).ready, true);
  const state = JSON.parse(await readFile(join(home, 'state', 'state.json')));
  assert.equal(state.executable, join(bin, 'doomer'));
  assert.equal((await exec(process.execPath, [state.executable, '--version'], { env })).stdout.trim(), '0.1.0');
  assert.ok((await readdir(bin)).some(name => name.startsWith('doomer.before-doomer-node-')));
  const hooks = JSON.parse(await readFile(join(codex, 'hooks.json')));
  assert.equal(hooks.trust, 'keep'); assert.equal(hooks.hooks.Stop[0].hooks[0].command, 'echo keep');
  assert.match(hooks.hooks.Stop[1].hooks[0].command, /--owner=doomer-node/);
  assert.equal(JSON.parse((await cli(['doctor', '--json'])).stdout).ready, true);
  const calls = (await readFile(join(home, 'calls'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.some(args => args.includes('skills') && args.includes('doomerlabs/skills') && args.includes('doomer') && args.includes('--global')));
  await cli(['onboard', '--agent', 'codex']);
  assert.equal((await readFile(join(home, 'calls'), 'utf8')).trim().split('\n').length, calls.length, 'skill-first/onboard reuses installed CLI and skill');
  await writeFile(join(codex, 'hooks.json'), JSON.stringify({ hooks: {}, permissions: 'preserve' }));
  await assert.rejects(cli(['doctor', '--json']));
  await cli(['install-hooks', '--agent', 'codex']);
  assert.equal(JSON.parse((await cli(['doctor', '--json'])).stdout).ready, true);
  assert.equal(JSON.parse(await readFile(join(codex, 'hooks.json'))).permissions, 'preserve');
  await cli(['update']);
  assert.equal(JSON.parse((await cli(['doctor', '--json'])).stdout).ready, true);
});
