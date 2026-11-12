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

import { mkdtemp, writeFile, readFile, readlink, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { exec } from './helpers.js';

test('switching versions preserves a running watch and the previous executable', async t => {
  const home = await mkdtemp(join(tmpdir(), 'doomer-version-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const source = join(home, 'source');
  const env = { ...process.env, DOOMER_HOME: join(home, 'state'), DOOMER_BIN_DIR: join(home, 'bin'), DOOMER_NATIVE_BINARY: source };
  const install = async () => JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', 'import {installNative} from "./src/native.js"; console.log(JSON.stringify(await installNative()));'], { env })).stdout);
  const script = tag => `#!${process.execPath}\nif (process.argv.includes('--hold')) { console.log('${tag}'); setInterval(()=>{},1000); } else console.log(process.argv.includes('--help') ? 'Watch recursively and review settled changes until stopped' : 'doomer dev');\n`;
  await writeFile(source, script('first'), { mode: 0o755 });
  const first = await install();
  const original = await readFile(first.path);
  const running = spawn(first.executable, ['--hold'], { env });
  const closed = once(running, 'close');
  t.after(async () => { if (running.exitCode === null) running.kill(); await closed; });
  await once(running.stdout, 'data');
  await writeFile(source, script('second'), { mode: 0o755 });
  const second = await install();
  assert.notEqual(first.path, second.path);
  assert.equal(await readlink(second.executable), basename(second.path));
  assert.deepEqual(await readFile(first.path), original);
  assert.equal(running.exitCode, null);
});
