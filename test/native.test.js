import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fixture, exec } from './helpers.js';
import { entry, hash } from '../src/system.js';
import { archiveBinary } from '../src/native.js';
import { gzipSync } from 'node:zlib';

test('native archive supports the published ./doomer path and rejects symlinks', () => {
  const header=Buffer.alloc(512);header.write('./doomer');header.write('00000000004\0',124);header[156]=48;
  const archive=()=>gzipSync(Buffer.concat([header,Buffer.from('test'),Buffer.alloc(508),Buffer.alloc(1024)]));
  assert.equal(archiveBinary(archive()).toString(),'test');
  header[156]=50;
  assert.throws(()=>archiveBinary(archive()),/Invalid native release executable/);
});

test('prompt and stop hooks start the Go watcher once and ignore tool events', async t => {
  const {dir} = await fixture();
  const home = await mkdtemp(join(tmpdir(),'doomer-native-'));
  t.after(()=>Promise.all([rm(home,{recursive:true,force:true}),rm(dir,{recursive:true,force:true})]));
  const binary = join(home,'doomer-go');
  await writeFile(binary, `#!/usr/bin/env node
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const args=process.argv.slice(2);const val=k=>args[args.indexOf(k)+1];
const root=path.join(process.env.DOOMER_CONFIG_DIR,'watch',crypto.createHash('sha256').update(val('--api-url')+'\\0'+val('--profile')).digest('hex'));
fs.mkdirSync(root,{recursive:true});fs.appendFileSync(path.join(root,'commands'),JSON.stringify(args)+'\\n');
const processFile=path.join(root,'process.json');
if(args.includes('--version')){console.log('doomer test');}
else if(args.includes('status')){console.log(JSON.stringify({running:fs.existsSync(processFile),paused:false,all_changes:true}));}
else if(args.includes('--managed-session')){
 fs.writeFileSync(processFile,JSON.stringify({pid:process.pid,managed_session:val('--managed-session')}));
 fs.writeFileSync(path.join(root,'heartbeat.json'),JSON.stringify(new Date().toISOString()));
 const timer=setInterval(()=>{if(fs.existsSync(path.join(root,'paused.json'))){fs.rmSync(processFile,{force:true});clearInterval(timer);}else fs.writeFileSync(path.join(root,'heartbeat.json'),JSON.stringify(new Date().toISOString()));},50);
}else if(args.includes('stop')){fs.writeFileSync(path.join(root,'paused.json'),'true');}
else if(args.includes('hook')){
 let raw='';process.stdin.on('data',v=>raw+=v);process.stdin.on('end',()=>{const event=JSON.parse(raw);fs.appendFileSync(path.join(root,'events'),raw+'\\n');console.log(JSON.stringify(event.hook_event_name==='Stop'?{decision:'block',reason:'Native Quick result'}:{}));});
}
`,{mode:0o755});
  const env={...process.env,DOOMER_HOME:home};
  const api='https://doomer.ai/api';
  await writeFile(join(home,'state.json'),JSON.stringify({version:1,agents:['codex'],native:{path:binary,allChanges:true},api,grants:[{scope:'global',api,approvedAt:new Date().toISOString()}]}));
  const call=async event=>{
    const child=spawn(process.execPath,[entry,'hook','--agent','codex'],{env});
    let out='';child.stdout.on('data',d=>out+=d);child.stderr.resume();
    child.stdin.end(JSON.stringify({session_id:'session',turn_id:'turn',cwd:dir,...event}));
    const [code]=await once(child,'close');assert.equal(code,0);return JSON.parse(out);
  };
  const root=join(home,'native-state','watch',hash(api+'\0node-codex'));
  t.after(async()=>{await writeFile(join(root,'paused.json'),'true').catch(()=>{});await new Promise(r=>setTimeout(r,100));});
  assert.deepEqual(await call({hook_event_name:'UserPromptSubmit',prompt:'edit source'}),{});
  await call({hook_event_name:'PreToolUse',tool_name:'apply_patch',tool_use_id:'tool1',tool_input:{patch:'test'}});
  await call({hook_event_name:'PostToolUse',tool_name:'apply_patch',tool_use_id:'tool1'});
  const result=await call({hook_event_name:'Stop'});
  assert.equal(result.reason,'Native Quick result');
  const commands=(await readFile(join(root,'commands'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(commands.filter(args=>args.includes('--managed-session')).length,1);
  assert.ok(commands.some(args=>args.includes('--all-changes')));
  assert.equal(commands.some(args=>args.includes('review')),false,'hooks never ask Node or the agent to submit a manual review');
  const events=(await readFile(join(root,'events'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(e=>e.hook_event_name),['UserPromptSubmit','Stop']);
  const config=JSON.parse(await readFile(join(root,'config.json')));
  assert.equal(config.all_repositories,true);assert.equal(config.explicit_consent,true);
  await exec(process.execPath,[entry,'revoke'],{env});
});
