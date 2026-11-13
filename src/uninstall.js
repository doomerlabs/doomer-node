import { readFile, readdir, lstat, readlink, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { agents, hookFile, globalSkillPaths, removeHooks } from './hooks.js';
import { paths, nativePath, developmentInstall, packageRoot, readState, readJSON, writeJSON, changeState, exists, locked, run, hash } from './system.js';
import { endpoint } from './api.js';
import { reloadCodexHooks } from './codex.js';

const inside = (root, path) => {
  if (typeof path !== 'string' || !isAbsolute(path)) return false;
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

async function canRemoveHome(home, state) {
  if ([resolve('/'), resolve(homedir()), resolve(tmpdir()), resolve(packageRoot), resolve(process.cwd())].includes(home)) return false;
  if (await exists(join(home,'.git')) || await exists(join(home,'package.json'))) return false;
  if ((await lstat(home)).isSymbolicLink()) return false;
  return state.version === 1 && [state.runtime, state.native?.path, state.hookLauncher].some(path => inside(home,path));
}

async function stopWatchers(home, state) {
  const directory = join(home,'native-state','watch');
  if (!await exists(directory)) return;
  for (const item of await readdir(directory,{withFileTypes:true})) {
    if (!item.isDirectory()) continue;
    const root = join(directory,item.name);
    const config = await readJSON(join(root,'config.json'));
    if (!config || !/^node-(codex|claude|manual)$/.test(config.profile || '') || hash(`${config.api_url}\0${config.profile}`) !== item.name) continue;
    await locked(join(root,'node-start'),async()=>{
      if (!await exists(join(root,'process.json'))) return;
      if (!state.native?.path || !await exists(state.native.path)) throw new Error(`Cannot stop the watcher in ${root}: native CLI is missing. Managed data was retained.`);
      await run(state.native.path,['--api-url',endpoint(config.api_url),'--profile',config.profile,'watch','stop'],{
        env:{...process.env,DOOMER_CONFIG_DIR:join(home,'native-state')},timeout:20000,
      });
      for (let attempt=0;attempt<100;attempt++) {
        if (!await exists(join(root,'process.json'))) return;
        await sleep(100);
      }
      throw new Error(`Watcher did not stop in ${root}; managed data was retained.`);
    });
  }
}

async function removeGlobalCommand(home, state) {
  const file = state.executable;
  if (!file || basename(file) !== basename(nativePath())) return {};
  const binaries = state.binaries || {};
  const owned = path => dirname(path) === dirname(file) && /^doomer-[a-z0-9][a-z0-9._-]*$/i.test(basename(path)) && binaries[path];
  const result = {};
  if (await exists(file)) {
    const info = await lstat(file);
    const target = info.isSymbolicLink() ? resolve(dirname(file), await readlink(file)) : '';
    if (target && owned(target)) {
      await rm(file);
      result.removedExecutable = file;
    } else result.preservedExecutable = file;
  }
  for (const path of Object.keys(binaries)) {
    if (!owned(path) || !await exists(path)) continue;
    if ((await lstat(path)).isFile() && hash(await readFile(path)) === binaries[path]) await rm(path);
  }
  return result;
}

async function removeSkill(directory) {
  if (basename(directory)!=='doomer' || basename(dirname(directory))!=='skills') return false;
  if (!await exists(directory)) return false;
  let text;
  try {text=await readFile(join(directory,'SKILL.md'),'utf8');}
  catch(error) {if(error.code==='ENOENT')return false;throw error;}
  if (!/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(text) || !/^name:\s*doomer\s*$/m.test(text.split(/^---\s*$/m)[1] || '')) return false;
  const info=await lstat(directory);
  await rm(directory,{recursive:!info.isSymbolicLink(),force:true});
  return true;
}

export async function uninstall() {
  const p=paths();
  const homeExists=await exists(p.home);
  const state=await readState();
  const removeData=homeExists && await canRemoveHome(p.home,state);
  const result={removedHooks:[],removedSkills:[],removedData:false};
  // Validate ownership before writing or recursively deleting anything.
  if (homeExists && !removeData) throw new Error(`Refusing to remove unrecognized installation directory ${p.home}.`);
  const cleanup=async()=>{
  if (homeExists) {
    await writeJSON(join(p.home,'uninstalling.json'),{startedAt:new Date().toISOString()});
    if(await exists(p.state)) await changeState(s=>{s.grants=[];});
  }
  const hookFiles=[...new Set([...(state.hookFiles||[]),...agents.map(hookFile)])];
  for (const file of hookFiles) if(await removeHooks(file)) result.removedHooks.push(file);
  if(result.removedHooks.some(file=>basename(file)==='hooks.json'))result.codexReload=await reloadCodexHooks();
  if(homeExists)await stopWatchers(p.home,state);
  const skills=[...new Set([...(state.skillPaths||[]),...globalSkillPaths()])];
  // Remove per-agent links before the shared canonical copy.
  const sorted=await Promise.all(skills.map(async path=>({path,link:await exists(path)&&(await lstat(path)).isSymbolicLink()})));
  sorted.sort((a,b)=>Number(b.link)-Number(a.link));
  for (const {path} of sorted) if(!developmentInstall() && await removeSkill(path)) result.removedSkills.push(path);
  Object.assign(result,await removeGlobalCommand(p.home,state));
  if(removeData) {await rm(p.home,{recursive:true,force:true});result.removedData=true;}
  return result;
  };
  return homeExists ? locked(join(p.home,'install'),cleanup) : cleanup();
}
