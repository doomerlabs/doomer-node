import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm, lstat, cp, symlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exec } from './helpers.js';
import { entry, packageRoot, metadata } from '../src/system.js';
import { SKILL_SOURCE } from '../src/skill-source.js';

test('global install replaces the old CLI, installs skills via official CLI, repairs hooks and supports skill-first onboarding', async t => {
  const home = await mkdtemp(join(tmpdir(), 'doomer-install-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const repository = join(home, 'skill-repository');
  await mkdir(repository);
  const git = (...args) => exec('git', ['-C', repository, ...args]);
  await git('init', '-q');
  await git('config', 'user.name', 'Test');
  await git('config', 'user.email', 'test@example.invalid');
  await writeFile(join(repository, 'SKILL.md'), '---\nname: doomer\n---\n');
  await git('add', '.'); await git('commit', '-qm', 'reviewed skill');
  const skillRevision = (await git('rev-parse', 'HEAD')).stdout.trim();
  await writeFile(join(repository, 'SKILL.md'), 'newer unreviewed skill');
  await git('commit', '-qam', 'newer skill');
  const gitConfig = join(home, 'gitconfig');
  await exec('git', ['config', '--file', gitConfig, `url.${repository}.insteadOf`, 'https://github.com/doomerlabs/skills.git']);
  const source = join(home, 'source');
  await mkdir(source);
  for (const name of ['src', 'bin', 'package.json', 'package-lock.json', 'README.md', 'LICENSE']) {
    await cp(join(packageRoot, name), join(source, name), { recursive: true });
  }
  await symlink(join(packageRoot, 'node_modules'), join(source, 'node_modules'), 'dir');
  const sourcePin = join(source, 'src', 'skill-source.js');
  await writeFile(sourcePin, (await readFile(sourcePin, 'utf8')).replace(SKILL_SOURCE.split('#')[1], skillRevision));
  const localEntry = join(source, 'bin', 'doomer.js');
  const npm = join(home, 'fake-npm.mjs');
  const native = join(home, 'fake-go');
  await writeFile(native, `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('codex-policy')) {
  const installed = join(process.env.HOME, 'policy-installed');
  appendFileSync(join(process.env.HOME, 'policy-calls'), JSON.stringify(args)+'\\n');
  if (args.includes('--decision')) {
    if (args[args.indexOf('--proposal')+1] !== 'fixture-scope-digest') process.exit(2);
    writeFileSync(installed, 'configured');
  }
  console.log(JSON.stringify({policies:[{state:existsSync(installed)?'configured':'missing',extra_policy:'fixture scoped authorization',changes:['preserve unrelated settings'],activation:'unverified',install_command:[process.argv[1],'watch','codex-policy','--proposal','fixture-scope-digest','--decision','allow']}],activation:'unverified'}));
} else console.log(args.includes('--help') ? 'Watch recursively and review settled changes until stopped --manager-home --agent' : 'doomer 2026.11.10.3');
`, {mode:0o755});
  await writeFile(npm, `
import { cp, mkdir, writeFile, appendFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
const args = process.argv.slice(2);
await appendFile(join(process.env.HOME, 'calls'), JSON.stringify(args)+'\\n');
if (args[0] === 'pack') {
  const name = 'doomerlabs-doomer-${metadata.version}.tgz';
  await writeFile(join(args[args.indexOf('--pack-destination')+1], name), 'fixture');
  console.log(JSON.stringify([{filename:name}]));
} else if (args[0] === 'install') {
  console.log('npm install progress');
  const root = join(args[args.indexOf('--prefix')+1], 'node_modules', '@doomerlabs', 'doomer');
  await cp(process.env.SOURCE, root, { recursive: true });
} else if (args[0] === 'exec') {
  const checkout = args[args.indexOf('add') + 1];
  if (!(await stat(checkout)).isDirectory()) throw new Error('missing checkout');
  const local = checkout === process.env.LOCAL_SKILL_SOURCE;
  if (!local && execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], {encoding:'utf8'}).trim() !== process.env.EXPECTED_SKILL_REVISION) throw new Error('wrong skill revision');
  if (process.env.FAIL_SKILL_INSTALL === '1') throw new Error('simulated skills failure');
  console.log('skills install progress');
  const root = join(process.env.HOME, '.agents', 'skills', 'doomer');
  await mkdir(root, { recursive: true });
  await cp(join(checkout, ...(local ? ['skills', 'doomer'] : []), 'SKILL.md'), join(root, 'SKILL.md'));
} else if (args[0] === 'view') console.log('${JSON.stringify(metadata.version)}');
else process.exit(1);
`);
  const bin = join(home, '.local', 'bin'); await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'doomer'), 'old doomer');
  const codex = join(home, '.codex'); await mkdir(codex);
  await writeFile(join(codex, 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo keep' }] }] }, trust: 'keep' }));
  const env = { ...process.env, DOOMER_API_URL:'https://doomer.ai/api', GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1', EXPECTED_SKILL_REVISION: skillRevision, HOME: home, DOOMER_HOME: join(home, 'state'), DOOMER_BIN_DIR: bin, CODEX_HOME: codex, CLAUDE_CONFIG_DIR: join(home, '.claude'), npm_execpath: npm, SOURCE: source, DOOMER_NATIVE_BINARY:native };
  const cli = args => exec(process.execPath, [localEntry, ...args], { env });
  assert.deepEqual(JSON.parse((await cli(['install-hooks', '--no-hooks', '--json'])).stdout), {
    status: 'skipped', agents: [], installed: false,
  });
  await assert.rejects(cli(['install', '--agent', 'codex', '--json']), /Upload approval is required/);
  await assert.rejects(access(join(home, 'state', 'state.json')), { code: 'ENOENT' });
  await assert.rejects(access(join(home, 'calls')), { code: 'ENOENT' });
  assert.equal(JSON.parse((await cli(['install', '--agent', 'codex', '--approve-uploads', '--json'])).stdout).ready, true);
  const state = JSON.parse(await readFile(join(home, 'state', 'state.json')));
  assert.equal(state.executable, join(bin, 'doomer'));
  assert.equal(JSON.parse((await cli(['doctor', '--json'])).stdout).capabilities.watchAgentHook, true);
  assert.equal((await exec(state.executable, ['--version'], { env })).stdout.trim(), 'doomer 2026.11.10.3');
  assert.equal((await lstat(state.executable)).isSymbolicLink(), true);
  assert.equal(state.native.path, join(bin, 'doomer-dev'));
  assert.equal((await lstat(state.native.path)).isFile(), true);
  const hooks = JSON.parse(await readFile(join(codex, 'hooks.json')));
  assert.equal(hooks.trust, 'keep'); assert.equal(hooks.hooks.Stop[0].hooks[0].command, 'echo keep');
  assert.match(hooks.hooks.Stop[1].hooks[0].command, /--owner=doomer-node/);
  assert.ok(hooks.hooks.Stop[1].hooks[0].command.includes(state.executable));
  assert.equal((await exec(process.execPath, [state.hookLauncher, '--version'], { env })).stdout.trim(), metadata.version);
  assert.equal(JSON.parse((await cli(['doctor', '--json'])).stdout).ready, true);
  const calls = (await readFile(join(home, 'calls'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.some(args => args.includes('skills') && args.some(arg => arg.includes('doomer-skill-') && arg.endsWith('/checkout')) && args.includes('doomer') && args.includes('--global')));
  for (const call of calls.filter(args => args[0] === 'exec')) {
    await assert.rejects(access(call[call.indexOf('add') + 1]), { code: 'ENOENT' });
  }
  assert.ok(calls.some(args => args[0] === 'pack'), 'install persists the running package without a published npm version');
  assert.ok(calls.some(args => args[0] === 'install' && args.at(-1).endsWith('.tgz')));
  env.DOOMER_TOKEN = 'account-token-for-test';
  env.DOOMER_CONFIG_DIR = join(home, 'production-config');
  const proposed = JSON.parse((await cli(['onboard', '--agent', 'codex', '--approve-uploads', '--json'])).stdout);
  assert.equal(proposed.codexReviewPolicy.policies[0].state, 'missing');
  assert.equal(proposed.codexReviewPolicy.policies[0].extra_policy, 'fixture scoped authorization');
  await assert.rejects(access(join(home, 'policy-installed')));
  const accepted = JSON.parse((await cli(['onboard', '--agent', 'codex', '--reviewer-policy', 'allow', '--reviewer-policy-proposal', 'fixture-scope-digest', '--json'])).stdout);
  assert.equal(accepted.codexReviewPolicy.policies[0].state, 'configured');
  const policyCalls = (await readFile(join(home, 'policy-calls'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(policyCalls.some(args => args.includes('--decision') && args[args.indexOf('--proposal')+1] === 'fixture-scope-digest'));
  await mkdir(join(home, '.claude', 'skills', 'doomer'), { recursive: true });
  await writeFile(join(home, '.claude', 'skills', 'doomer', 'SKILL.md'), '---\nname: doomer\n---\n');
  const otherAgent = JSON.parse((await cli(['onboard', '--agent', 'claude', '--json'])).stdout);
  assert.equal(otherAgent.codexReviewPolicy.policies[0].state, 'configured');
  const checked = JSON.parse((await cli(['doctor', '--json'])).stdout);
  assert.equal(checked.codexReviewPolicy.policies[0].state, 'configured');
  assert.equal(checked.issues.some(issue => issue.code === 'reviewer_policy_unavailable'), false);
  const alternate = JSON.parse((await cli(['doctor', '--api-url', 'https://other.example/api', '--json'])).stdout);
  assert.equal(alternate.uploadApproved, false);
  assert.equal(alternate.codexReviewPolicy, undefined, 'does not inspect a saved grant for another endpoint');
  const brokenHooks = JSON.parse(await readFile(join(codex, 'hooks.json'), 'utf8'));
  delete brokenHooks.hooks.Stop;
  await writeFile(join(codex, 'hooks.json'), JSON.stringify(brokenHooks));
  const broken = JSON.parse((await exec(process.execPath, [localEntry, 'doctor', '--json'], {env}).catch(error => ({stdout:error.stdout}))).stdout);
  assert.equal(broken.ready, false);
  const doctorRepaired = JSON.parse((await cli(['doctor', '--fix', '--json'])).stdout);
  assert.equal(doctorRepaired.ready, true);
  assert.equal(doctorRepaired.codexReviewPolicy.policies[0].state, 'configured');


  assert.equal((await readFile(join(home, 'calls'), 'utf8')).trim().split('\n').length, calls.length, 'skill-first/onboard reuses installed CLI and skill');
  const approved = JSON.parse(await readFile(join(home, 'state', 'state.json')));
  assert.equal(approved.grants[0].scope, 'global');
  assert.match(approved.identities['https://doomer.ai/api'], /^doomer_anon_/);
  assert.ok(!JSON.stringify(approved).includes('account-token-for-test'), 'environment token is not copied into installer state');
  assert.equal(approved.credentialDirs['https://doomer.ai/api'], env.DOOMER_CONFIG_DIR);
  delete env.DOOMER_TOKEN;
  delete env.DOOMER_CONFIG_DIR;
  assert.equal(approved.grants[0].repo, undefined);
  assert.equal(approved.grants[0].agents, undefined);
  await exec(process.execPath, [entry, 'revoke'], {env, cwd: home});
  assert.equal(JSON.parse(await readFile(join(home, 'state', 'state.json'))).grants.length, 0);
  assert.equal(JSON.parse((await cli(['doctor', '--json'])).stdout).reviewerAuthorization.uploadConsent, 'not_approved');
  await writeFile(join(codex, 'hooks.json'), JSON.stringify({ hooks: {}, permissions: 'preserve' }));
  await assert.rejects(cli(['doctor', '--json']));
  await cli(['install-hooks', '--agent', 'codex']);
  assert.equal(JSON.parse((await cli(['doctor', '--json'])).stdout).ready, true);
  assert.equal(JSON.parse(await readFile(join(codex, 'hooks.json'))).permissions, 'preserve');
  const callsBeforeUpdate = (await readFile(join(home, 'calls'), 'utf8')).trim().split('\n').length;
  // Update repairs policy as well as hooks, without silently accepting it.
  const before = JSON.parse(await readFile(join(home, 'state', 'state.json')));
  before.grants = [{scope:'global',api:'https://doomer.ai/api'}];
  await writeFile(join(home, 'state', 'state.json'), JSON.stringify(before));
  await rm(join(home, 'policy-installed'));
  const updated = JSON.parse((await cli(['update', '--json'])).stdout);
  assert.equal(updated.codexReviewPolicy.policies[0].state, 'missing');
  assert.equal(updated.reviewerAuthorization.policy, 'missing_or_outdated');
  assert.equal(updated.reviewerAuthorization.uploadConsent, 'approved');
  await assert.rejects(access(join(home, 'policy-installed')));
  const repaired = JSON.parse((await cli(['update', '--reviewer-policy', 'allow', '--reviewer-policy-proposal', 'fixture-scope-digest', '--json'])).stdout);
  assert.equal(repaired.reviewerAuthorization.policy, 'installed');
  assert.equal(repaired.reviewerAuthorization.activation, 'unverified');
  const updateCalls = (await readFile(join(home, 'calls'), 'utf8')).trim().split('\n').slice(callsBeforeUpdate).map(JSON.parse);
  assert.ok(updateCalls.some(args => args[0] === 'view' && args[1] === '@doomerlabs/doomer@beta'));
  assert.equal(JSON.parse((await cli(['doctor', '--json'])).stdout).ready, true);
  // Legacy environment overrides cannot restore obsolete global scope.
  env.DOOMER_HOOK_ROOT = join(home, 'ignored-legacy-root');
  // Reinstall removes obsolete global scope; hooks use each session cwd.
  const stale = JSON.parse(await readFile(join(home, 'state', 'state.json')));
  stale.hookRoot = join(home, 'deleted-scope');
  await writeFile(join(home, 'state', 'state.json'), JSON.stringify(stale));
  await cli(['install-hooks', '--agent', 'codex']);
  assert.equal(JSON.parse(await readFile(join(home, 'state', 'state.json'))).hookRoot, undefined);
  assert.equal(JSON.parse((await cli(['doctor', '--json'])).stdout).ready, true);
  await writeFile(join(home, 'state', 'state.json'), JSON.stringify(stale));
  await cli(['onboard', '--agent', 'codex']);
  assert.equal(JSON.parse(await readFile(join(home, 'state', 'state.json'))).hookRoot, undefined);
  const updatedHooks = JSON.parse(await readFile(join(codex, 'hooks.json')));
  assert.equal(updatedHooks.hooks.Stop[0].hooks[0].command, hooks.hooks.Stop[1].hooks[0].command, 'updates retain the stable hook command');
  assert.ok(!JSON.stringify(updatedHooks).includes(env.DOOMER_HOOK_ROOT));
  const localSkills = join(home, 'local-skills');
  await mkdir(join(localSkills, 'skills', 'doomer'), {recursive:true});
  await writeFile(join(localSkills, 'skills', 'doomer', 'SKILL.md'), '---\nname: doomer\n---\nlocal draft');
  env.LOCAL_SKILL_SOURCE = localSkills;
  const refreshed = await cli(['onboard', '--agent', 'codex', '--skill-source', localSkills, '--json']);
  assert.equal(JSON.parse(refreshed.stdout).ready, true);
  const installedSkill = join(home, '.agents', 'skills', 'doomer', 'SKILL.md');
  assert.equal(await readFile(installedSkill, 'utf8'), await readFile(join(localSkills, 'skills', 'doomer', 'SKILL.md'), 'utf8'));
  const localCalls = (await readFile(join(home, 'calls'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(localCalls.some(args => args[0] === 'exec' && args[args.indexOf('add') + 1] === localSkills), 'explicit local skill refreshes an existing installation');
  await cli(['onboard', '--agent', 'codex', '--json']);
  const repeatedCalls = (await readFile(join(home, 'calls'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(repeatedCalls.filter(args => args[0] === 'exec').length, localCalls.filter(args => args[0] === 'exec').length, 'plain onboarding preserves an installed local skill');
  assert.match(await readFile(installedSkill, 'utf8'), /local draft/);
  env.FAIL_SKILL_INSTALL = '1';
  await assert.rejects(cli(['install', '--agent', 'codex', '--json']));
  const failedCalls = (await readFile(join(home, 'calls'), 'utf8')).trim().split('\n').map(JSON.parse);
  const failedSkill = failedCalls.filter(args => args[0] === 'exec').at(-1);
  await assert.rejects(access(failedSkill[failedSkill.indexOf('add') + 1]), { code: 'ENOENT' });

});
