import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureReviewerPolicy, inspectReviewerPolicies } from '../src/reviewer-policy.js';

test('policy consent is separate, uses Go proposal commands, and preserves explicit declines', async t => {
  const home = await mkdtemp(join(tmpdir(), 'policy-'));
  const previous = process.env.DOOMER_HOME;
  process.env.DOOMER_HOME = home;
  t.after(async () => { if (previous === undefined) delete process.env.DOOMER_HOME; else process.env.DOOMER_HOME = previous; await rm(home, {recursive:true,force:true}); });
  await writeFile(join(home,'state.json'), JSON.stringify({api:'https://doomer.ai/api',grants:[{scope:'global',api:'https://doomer.ai/api'}]}));
  let state = 'missing'; const calls=[];
  const execute = async (exe,args) => {
    calls.push(args);
    if (args.includes('--decision')) state=args.at(-1)==='allow' ? 'configured' : 'declined';
    return Buffer.from(JSON.stringify({policies:[{state,extra_policy:'exact scoped policy',changes:['preserve settings'],install_command:[process.execPath,'--proposal','scope-digest','--decision','allow'],decline_command:[process.execPath,'--proposal','scope-digest','--decision','decline']}],activation:'unverified'}));
  };
  const ask=()=>{throw new Error('noninteractive test must not prompt');};
  let result=await configureReviewerPolicy(process.execPath,{'approve-uploads':true,'api-url':'https://doomer.ai/api'},ask,execute);
  assert.equal(result.policies[0].state,'missing');
  assert.equal(calls.some(args=>args.includes('--decision')),false);
  await assert.rejects(configureReviewerPolicy(process.execPath,{'reviewer-policy':'allow','reviewer-policy-proposal':'stale','api-url':'https://doomer.ai/api'},ask,execute), /changed or has not been reviewed/);
  result=await configureReviewerPolicy(process.execPath,{'reviewer-policy':'allow','reviewer-policy-proposal':'scope-digest','api-url':'https://doomer.ai/api'},ask,execute);
  assert.equal(result.policies[0].state,'configured'); assert.equal(result.activation,'unverified');
  state='missing';
  await configureReviewerPolicy(process.execPath,{'reviewer-policy':'decline','reviewer-policy-proposal':'scope-digest','api-url':'https://doomer.ai/api'},ask,execute);
  const count=calls.filter(args=>args.includes('--decision')).length;
  await configureReviewerPolicy(process.execPath,{'reviewer-policy':'allow','reviewer-policy-proposal':'scope-digest','api-url':'https://doomer.ai/api'},ask,execute);
  assert.equal(calls.filter(args=>args.includes('--decision')).length,count);
  await writeFile(join(home,'state.json'), JSON.stringify({grants:[]}));
  await assert.rejects(configureReviewerPolicy(process.execPath,{'reviewer-policy':'allow','api-url':'https://doomer.ai/api'},ask,execute), /no decision was applied/);
});


test('policy diagnostics inspect each existing account profile without accepting decisions', async t => {
  const home = await mkdtemp(join(tmpdir(), 'profile-policy-'));
  const keys = ['HOME','DOOMER_HOME','CODEX_HOME'];
  const before = Object.fromEntries(keys.map(key => [key,process.env[key]]));
  t.after(async () => {
    for (const key of keys) if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
    await rm(home,{recursive:true,force:true});
  });
  process.env.HOME = home;
  process.env.DOOMER_HOME = home;
  delete process.env.CODEX_HOME;
  await writeFile(join(home,'state.json'),JSON.stringify({api:'https://doomer.ai/api',grants:[{api:'https://doomer.ai/api'}]}));
  const profile = join(home,'Library','Application Support','Codex Accounts','profiles','one','home');
  await mkdir(profile,{recursive:true});
  await writeFile(join(profile,'hooks.json'),JSON.stringify({hooks:{Stop:[{hooks:[{command:'doomer agent-hook --managed-task-adapter'}]}]}}));
  const homes=[];
  const result=await inspectReviewerPolicies(process.execPath,{'api-url':'https://doomer.ai/api'},async (_exe,args,options) => {
    assert.equal(args.includes('--decision'),false);
    homes.push(options.env.CODEX_HOME);
    return Buffer.from(JSON.stringify({policies:[{state:'configured'}]}));
  });
  assert.deepEqual(homes,[join(home,'.codex'),profile]);
  assert.equal(result.policies.length,2);
  assert.equal(result.error,undefined);
  const decisions=[];
  const execute=async (_exe,args,options) => {
    const current=options.env.CODEX_HOME;
    if (args.includes('--decision')) decisions.push(current);
    const digest=current===profile ? 'profile-digest' : 'default-digest';
    return Buffer.from(JSON.stringify({policies:[{state:'missing',extra_policy:'scoped',changes:[],install_command:[process.execPath,'--proposal',digest,'--decision','allow']}]}));
  };
  const ask=()=>{throw new Error('must not prompt');};
  await assert.rejects(configureReviewerPolicy(process.execPath,{'api-url':'https://doomer.ai/api','reviewer-policy':'allow','reviewer-policy-proposal':'stale'},ask,execute),/changed/);
  assert.deepEqual(decisions,[]);
  await configureReviewerPolicy(process.execPath,{'api-url':'https://doomer.ai/api','reviewer-policy':'allow','reviewer-policy-proposal':'profile-digest'},ask,execute);
  assert.deepEqual(decisions,[profile], 'explicit consent targets only the matching profile');
  const partial=await configureReviewerPolicy(process.execPath,{'api-url':'https://doomer.ai/api','reviewer-policy':'allow','reviewer-policy-proposal':'profile-digest'},ask,async (exe,args,options) => {
    if (options.env.CODEX_HOME !== profile) throw new Error('other profile unavailable');
    return execute(exe,args,options);
  });
  assert.deepEqual(decisions,[profile,profile]);
  assert.match(partial.error,/other profile unavailable/);
});
