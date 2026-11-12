import { stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { metadata } from './system.js';

// Existing sessions keep a config snapshot. Empty edits plus reloadUserConfig
// refresh that snapshot without changing the config file or trusting hooks.
export async function reloadCodexHooks({ socketPath, timeout = 5000 } = {}) {
  const home = process.env.CODEX_HOME || join(homedir(), '.codex');
  const path = socketPath || process.env.DOOMER_CODEX_SOCKET || join(home, 'app-server-control', 'app-server-control.sock');
  try {
    if (!(await stat(path)).isSocket()) throw new Error('Codex control path is not a socket.');
  } catch (error) {
    return { reloaded:false, restartRequired:true, reason:error.code === 'ENOENT' ? 'No running local Codex control socket was found.' : error.message };
  }
  return new Promise(resolve => {
    let done = false;
    const socket = new WebSocket('ws://localhost', {
      createConnection: () => createConnection(path), handshakeTimeout:timeout,
      perMessageDeflate:false, maxPayload:1024 * 1024,
    });
    const finish = result => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.terminate();
      resolve(result);
    };
    const failure = reason => finish({reloaded:false,restartRequired:true,reason});
    const timer = setTimeout(() => failure('Codex hook reload timed out.'), timeout);
    socket.on('error', error => failure(error.message));
    socket.on('close', () => {if (!done) failure('Codex disconnected before confirming the reload.');});
    socket.on('open', () => socket.send(JSON.stringify({
      id:1,method:'initialize',params:{clientInfo:{name:'doomer_hook_reload',version:metadata.version},capabilities:{experimentalApi:true}},
    })));
    socket.on('message', data => {
      let message;
      try {message=JSON.parse(data.toString());} catch {failure('Codex returned invalid JSON.');return;}
      if (![1,2].includes(message.id)) return;
      if (message.error) {failure(String(message.error.message || 'Codex rejected the reload.').slice(0,300));return;}
      if (message.id === 1) {
        socket.send(JSON.stringify({method:'initialized',params:{}}));
        socket.send(JSON.stringify({id:2,method:'config/batchWrite',params:{edits:[],reloadUserConfig:true}}));
      } else if (message.result?.status === 'ok') {
        finish({reloaded:true,restartRequired:false,trust:'user_managed'});
      } else failure('Codex did not confirm the reload.');
    });
  });
}

export function reloadMessage(result) {
  return result.reloaded
    ? 'Codex hooks reloaded without restarting. Open /hooks to review and trust new or changed hooks.'
    : `Codex hooks need a session restart: ${result.reason}`;
}
