import { mkdtemp, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
export const exec = promisify(execFile);
export async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'doomer-test-')));
  const git = (...args) => exec('git', ['-C', dir, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.invalid');
  await writeFile(join(dir, 'source.js'), 'export const answer = 1;\n');
  await writeFile(join(dir, '.gitignore'), 'ignored/\n');
  await git('add', '.'); await git('commit', '-qm', 'baseline');
  return { dir, git };
}
