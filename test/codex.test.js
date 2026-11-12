import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {WebSocketServer} from 'ws';
import {reloadCodexHooks} from '../src/codex.js';

async function server(t,handle) {
  const root=await mkdtemp(join(tmpdir(),'doomer-codex-reload-'));
  const path=join(root,'server.sock');
  const http=createServer();const wss=new WebSocketServer({server:http});
  wss.on('connection',socket=>socket.on('message',data=>handle(socket,JSON.parse(data))));
  http.listen(path);await once(http,'listening');
  t.after(async()=>{for(const client of wss.clients)client.terminate();await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>http.close(resolve));await rm(root,{recursive:true,force:true});});
  return path;
}

test('reload uses empty config edits and preserves hook trust',async t=>{
  const messages=[];
  const path=await server(t,(socket,message)=>{
    messages.push(message);
    if(message.method==='initialize')socket.send(JSON.stringify({id:message.id,result:{}}));
    if(message.method==='config/batchWrite')socket.send(JSON.stringify({id:message.id,result:{status:'ok'}}));
  });
  const result=await reloadCodexHooks({socketPath:path});
  assert.equal(result.reloaded,true);assert.equal(result.restartRequired,false);assert.equal(result.trust,'user_managed');
  assert.deepEqual(messages.map(m=>m.method),['initialize','initialized','config/batchWrite']);
  assert.deepEqual(messages.at(-1).params,{edits:[],reloadUserConfig:true});
});

test('unsupported servers return an explicit restart fallback',async t=>{
  const path=await server(t,(socket,message)=>{
    if(message.method==='initialize')socket.send(JSON.stringify({id:message.id,result:{}}));
    if(message.method==='config/batchWrite')socket.send(JSON.stringify({id:message.id,error:{code:-32601,message:'Method not found'}}));
  });
  const result=await reloadCodexHooks({socketPath:path});
  assert.equal(result.reloaded,false);assert.equal(result.restartRequired,true);assert.match(result.reason,/Method not found/);
});

test('unresponsive servers time out instead of hanging installation',async t=>{
  const path=await server(t,()=>{});
  const result=await reloadCodexHooks({socketPath:path,timeout:100});
  assert.equal(result.reloaded,false);assert.match(result.reason,/timed out/);
});

test('missing control sockets do not claim a reload',async()=>{
  const result=await reloadCodexHooks({socketPath:join(tmpdir(),'missing-doomer-control-socket')});
  assert.equal(result.reloaded,false);assert.equal(result.restartRequired,true);
});
