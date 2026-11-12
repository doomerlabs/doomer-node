import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,symlink,lstat,rm,readlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {entry,hash} from '../src/system.js';
import {exec} from './helpers.js';

async function fixture(t) {
  const home=await mkdtemp(join(tmpdir(),'doomer-uninstall-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const managed=join(home,'managed');
  const bin=join(home,'.local','bin');
  const codex=join(home,'custom-codex');
  const claude=join(home,'.claude');
  for(const dir of [managed,bin,codex,claude,join(managed,'bin')])await mkdir(dir,{recursive:true});
  const runtime=join(managed,'runtime','bin','doomer.js');
  await mkdir(join(managed,'runtime','bin'),{recursive:true});await writeFile(runtime,'// manager');
  const native=join(managed,'bin','doomer-go');
  const audit=join(home,'stopped');
  await writeFile(native,`#!/usr/bin/env node\nconst fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const args=process.argv.slice(2);const get=k=>args[args.indexOf(k)+1];const dir=path.join(process.env.DOOMER_CONFIG_DIR,'watch',crypto.createHash('sha256').update(get('--api-url')+'\\0'+get('--profile')).digest('hex'));fs.writeFileSync(process.env.UNINSTALL_AUDIT,'stopped');fs.rmSync(path.join(dir,'process.json'),{force:true});\n`,{mode:0o755});
  const global=join(bin,'doomer');await symlink(native,global);
  const api='https://doomer.ai/api';const profile='node-codex';
  const watch=join(managed,'native-state','watch',hash(api+'\0'+profile));
  await mkdir(watch,{recursive:true});
  await writeFile(join(watch,'config.json'),JSON.stringify({api_url:api,profile}));
  await writeFile(join(watch,'process.json'),'{}');
  const hook=join(codex,'hooks.json');
  await writeFile(hook,JSON.stringify({permissions:{deny:['keep']},hooks:{Stop:[{hooks:[{command:'echo unrelated'},{command:'node hook --owner=doomer-node'}]}],PreToolUse:[{hooks:[{command:'node hook --owner=doomer-node'}]}]}}));
  const skill=join(home,'.agents','skills','doomer');await mkdir(skill,{recursive:true});
  await writeFile(join(skill,'SKILL.md'),'---\nname: doomer\n---\n');
  await mkdir(join(codex,'skills'),{recursive:true});await symlink(skill,join(codex,'skills','doomer'));
  const old=join(home,'.agents','skills','doomer-review');await mkdir(old);await writeFile(join(old,'SKILL.md'),'old skill');
  await writeFile(join(managed,'state.json'),JSON.stringify({version:1,runtime,native:{path:native},executable:global,agents:['codex'],grants:[{scope:'global',api}],hookFiles:[hook]}));
  const env={...process.env,HOME:home,DOOMER_HOME:managed,CODEX_HOME:codex,CLAUDE_CONFIG_DIR:claude,UNINSTALL_AUDIT:audit};
  return {home,managed,global,native,hook,skill,old,audit,env,run:()=>exec(process.execPath,[entry,'uninstall','--json'],{env,cwd:home})};
}

test('uninstall stops watchers and removes only owned hooks, new skill, command and private data',async t=>{
  const f=await fixture(t);
  const result=JSON.parse((await f.run()).stdout);
  assert.equal(result.removedExecutable,f.global);assert.equal(result.removedData,true);
  await assert.rejects(lstat(f.managed),{code:'ENOENT'});await assert.rejects(lstat(f.global),{code:'ENOENT'});await assert.rejects(lstat(f.skill),{code:'ENOENT'});
  assert.equal(await readFile(f.audit,'utf8'),'stopped');
  const settings=JSON.parse(await readFile(f.hook));
  assert.deepEqual(settings.permissions,{deny:['keep']});
  assert.deepEqual(settings.hooks.Stop,[{hooks:[{command:'echo unrelated'}]}]);
  assert.equal(settings.hooks.PreToolUse,undefined);
  assert.equal(await readFile(join(f.old,'SKILL.md'),'utf8'),'old skill');
  assert.equal(JSON.parse((await f.run()).stdout).removedData,false,'repeat uninstall is safe');
});

test('uninstall preserves a global command replaced by the user',async t=>{
  const f=await fixture(t);
  const replacement=join(f.home,'user-go-build');await writeFile(replacement,'user build');
  await rm(f.global);await symlink(replacement,f.global);
  const result=JSON.parse((await f.run()).stdout);
  assert.equal(result.preservedExecutable,f.global);
  assert.equal(await readlink(f.global),replacement);
  assert.equal(await readFile(replacement,'utf8'),'user build');
});

test('uninstall refuses to recursively delete an unrecognized data directory',async t=>{
  const home=await mkdtemp(join(tmpdir(),'doomer-not-owned-'));t.after(()=>rm(home,{recursive:true,force:true}));
  await writeFile(join(home,'keep'),'important');
  await assert.rejects(exec(process.execPath,[entry,'uninstall'],{env:{...process.env,DOOMER_HOME:home}}),/unrecognized installation directory/);
  assert.equal(await readFile(join(home,'keep'),'utf8'),'important');
});
