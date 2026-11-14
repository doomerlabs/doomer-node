import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec } from './helpers.js';
import { withPinnedSkillCheckout, withSkillSource } from '../src/skill-source.js';

test('pinned checkout installs the exact commit without a matching branch or tag and cleans up', async t => {
  const repository = await mkdtemp(join(tmpdir(), 'skill-source-repo-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const git = (...args) => exec('git', ['-C', repository, ...args]);
  await git('init', '-q');
  await git('config', 'user.name', 'Test');
  await git('config', 'user.email', 'test@example.invalid');
  await writeFile(join(repository, 'SKILL.md'), 'reviewed commit');
  await git('add', '.'); await git('commit', '-qm', 'reviewed');
  const revision = (await git('rev-parse', 'HEAD')).stdout.trim();
  await writeFile(join(repository, 'SKILL.md'), 'newer branch content');
  await git('commit', '-qam', 'newer');
  let checkout;
  await withPinnedSkillCheckout(repository, revision, async path => {
    checkout = path;
    assert.equal(await readFile(join(path, 'SKILL.md'), 'utf8'), 'reviewed commit');
    assert.equal((await exec('git', ['-C', path, 'rev-parse', 'HEAD'])).stdout.trim(), revision);
    assert.equal((await exec('git', ['-C', path, 'branch', '--show-current'])).stdout.trim(), '');
  });
  await assert.rejects(access(checkout), { code: 'ENOENT' });
  await assert.rejects(withPinnedSkillCheckout(repository, revision, async path => {
    checkout = path; throw new Error('installer failed');
  }), /installer failed/);
  await assert.rejects(access(checkout), { code: 'ENOENT' });
  await assert.rejects(withPinnedSkillCheckout(repository, '0'.repeat(40), () => assert.fail('must not install missing commit')));
});

test('captured local E2E sources are preserved and unrecognized remote sources fail closed', async () => {
  const path = join(tmpdir(), 'captured-skill');
  await withSkillSource(actual => assert.equal(actual, path), path);
  await assert.rejects(withSkillSource(() => assert.fail('must not install'), 'other/repo#' + 'a'.repeat(40)), /Invalid official/);
});
