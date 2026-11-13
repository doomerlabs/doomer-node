import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveBinary } from '../src/native.js';
import { gzipSync } from 'node:zlib';

test('native archive supports the published ./doomer path and rejects symlinks', () => {
  const header=Buffer.alloc(512);header.write('./doomer');header.write('00000000004\0',124);header[156]=48;
  const archive=()=>gzipSync(Buffer.concat([header,Buffer.from('test'),Buffer.alloc(508),Buffer.alloc(1024)]));
  assert.equal(archiveBinary(archive()).toString(),'test');
  header[156]=50;
  assert.throws(()=>archiveBinary(archive()),/Invalid native release executable/);
});

import { mkdtemp, writeFile, readFile, readlink, rm, open } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { exec } from './helpers.js';

test('replacing doomer-dev preserves a running watch and its open executable', async t => {
  const home = await mkdtemp(join(tmpdir(), 'doomer-version-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const source = join(home, 'source');
  const env = { ...process.env, DOOMER_HOME: join(home, 'state'), DOOMER_BIN_DIR: join(home, 'bin'), DOOMER_NATIVE_BINARY: source };
  const install = async () => JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', 'import {installNative} from "./src/native.js"; console.log(JSON.stringify(await installNative()));'], { env })).stdout);
  const script = tag => `#!${process.execPath}\nif (process.argv.includes('--hold')) { console.log('${tag}'); setInterval(()=>{},1000); } else console.log(process.argv.includes('--help') ? 'Watch recursively and review settled changes until stopped --manager-home --agent' : 'doomer dev');\n`;
  await writeFile(source, script('first'), { mode: 0o755 });
  const first = await install();
  const original = await readFile(first.path);
  const previous = await open(first.path);
  t.after(() => previous.close());
  const running = spawn(first.executable, ['--hold'], { env });
  const closed = once(running, 'close');
  t.after(async () => { if (running.exitCode === null) running.kill(); await closed; });
  await once(running.stdout, 'data');
  await writeFile(source, script('second'), { mode: 0o755 });
  const second = await install();
  assert.equal(first.path, second.path);
  assert.equal(basename(second.path), 'doomer-dev');
  assert.equal(await readlink(second.executable), basename(second.path));
  assert.deepEqual(await previous.readFile(), original);
  assert.notDeepEqual(await readFile(second.path), original);
  assert.equal(running.exitCode, null);
});

test('development install preserves production executable and uses separate state', async t => {
  const { mkdtemp, mkdir, writeFile, readFile, symlink, readlink, lstat, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { installNative } = await import('../src/native.js');
  const { paths } = await import('../src/system.js');
  const root = await mkdtemp(join(tmpdir(), 'doomer-dev-isolation-'));
  const saved = Object.fromEntries(['DOOMER_DEV_INSTALL', 'DOOMER_DEV_HOME', 'DOOMER_HOME', 'DOOMER_BIN_DIR', 'DOOMER_NATIVE_BINARY'].map(k => [k, process.env[k]]));
  t.after(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(root, { recursive: true, force: true });
  });
  const bin = join(root, 'bin');
  await mkdir(bin);
  const production = join(bin, 'doomer-2026.11.10.3');
  await writeFile(production, 'production bytes');
  await symlink(production, join(bin, 'doomer'));
  const source = join(root, 'local-build');
  await writeFile(source, `#!${process.execPath}\nconsole.log(process.argv.includes('--help') ? 'Watch recursively and review settled changes until stopped --manager-home --agent --watch-root' : 'doomer dev');\n`, { mode: 0o755 });
  process.env.DOOMER_DEV_INSTALL = '1';
  process.env.DOOMER_DEV_HOME = join(root, 'dev-state');
  process.env.DOOMER_HOME = join(root, 'production-state');
  process.env.DOOMER_BIN_DIR = bin;
  process.env.DOOMER_NATIVE_BINARY = source;
  const result = await installNative();
  assert.equal(result.executable, join(bin, 'doomer-dev'));
  assert.equal((await lstat(result.executable)).isFile(), true);
  assert.equal(await readFile(production, 'utf8'), 'production bytes');
  assert.equal(await readlink(join(bin, 'doomer')), production);
  assert.equal(paths().home, join(root, 'dev-state'));
});


test('production-local and development profiles cannot overwrite each other', async t => {
  for (const firstDev of [false, true]) {
    const home = await mkdtemp(join(tmpdir(), 'doomer-owner-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    const source = join(home, 'source');
    await writeFile(source, `#!${process.execPath}\nconsole.log(process.argv.includes('--help') ? 'Watch recursively and review settled changes until stopped --manager-home --agent' : 'doomer dev');\n`, { mode: 0o755 });
    const env = { ...process.env, DOOMER_HOME: join(home, 'prod'), DOOMER_DEV_HOME: join(home, 'dev'), DOOMER_BIN_DIR: join(home, 'bin'), DOOMER_NATIVE_BINARY: source };
    const install = dev => exec(process.execPath, ['--input-type=module', '-e', 'import {installNative} from "./src/native.js"; console.log(JSON.stringify(await installNative()));'], { env: { ...env, DOOMER_DEV_INSTALL: dev ? '1' : '0' } });
    const first = JSON.parse((await install(firstDev)).stdout);
    const bytes = await readFile(first.path);
    await assert.rejects(install(!firstDev), /other installation uses doomer-dev/);
    assert.deepEqual(await readFile(first.path), bytes);
  }
});
