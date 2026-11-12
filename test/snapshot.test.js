import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './helpers.js';
import { baseline, worktree, diffSnapshots } from '../src/snapshot.js';

test('captures staged, unstaged, untracked and deleted files without touching the index', async t => {
  const { dir, git } = await fixture(); t.after(() => rm(dir, { recursive: true, force: true }));
  const before = await baseline(dir);
  await writeFile(join(dir, 'source.js'), 'export const answer = 2;\n');
  await git('add', 'source.js');
  await writeFile(join(dir, 'source.js'), 'export const answer = 3;\n');
  await writeFile(join(dir, 'new file.js'), 'new content\n');
  await mkdir(join(dir, 'ignored')); await writeFile(join(dir, 'ignored', 'secret'), 'secret');
  await rm(join(dir, '.gitignore'));
  // Keep ignored content excluded through .git/info/exclude after deleting .gitignore.
  await writeFile(join(dir, '.git', 'info', 'exclude'), 'ignored/\n');
  const index = (await git('ls-files', '--stage')).stdout;
  const after = await worktree(dir);
  assert.deepEqual(after.map(f => f.path), ['new file.js', 'source.js']);
  const diff = await diffSnapshots(before.files, after);
  assert.match(diff, /export const answer = 3/);
  assert.match(diff, /new file.js/);
  assert.match(diff, /deleted file mode/);
  assert.equal((await git('ls-files', '--stage')).stdout, index);
});

test('rejects symlinks and unresolved merges instead of following or skipping them', async t => {
  const { dir, git } = await fixture(); t.after(() => rm(dir, { recursive: true, force: true }));
  await symlink('/etc/passwd', join(dir, 'linked'));
  await assert.rejects(worktree(dir), /Symlinks/);
  await rm(join(dir, 'linked'));
  await git('checkout', '-qb', 'other');
  await writeFile(join(dir, 'source.js'), 'other\n'); await git('commit', '-qam', 'other');
  await git('checkout', 'main'); await writeFile(join(dir, 'source.js'), 'main\n'); await git('commit', '-qam', 'main');
  await git('merge', 'other').catch(() => {});
  await assert.rejects(worktree(dir), /merge conflicts/);
});
