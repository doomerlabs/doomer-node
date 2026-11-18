import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { join, resolve } from 'node:path';
import { locked, readJSON, run, writeJSON } from './system.js';
import { endpoint } from './api.js';
import { eventsFor } from './hooks.js';
import { claudeReviewRules } from './claude-policy.js';

const managedDirectory = '/usr/local/libexec/doomer-mdm';
const preferences = '/Library/Managed Preferences/com.doomerlabs.doomer.mdm.plist';
const tokenPattern = /^doomer_mdm_[A-Za-z0-9_-]{43}$/;
const clientTokenPattern = /^adv_cli_[A-Za-z0-9_-]{43}$/;
const supportedAgents = ['codex', 'claude'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseManagedProfile(value) {
  const email = typeof value?.WorkEmail === 'string' ? value.WorkEmail.trim().toLowerCase() : '';
  const agents = value?.Agents;
  if (value?.AuthorizeReviewUploads !== true || value?.AuthorizeReviewerCommands !== true || !tokenPattern.test(value?.EnrollmentKey)
    || typeof value.ApiURL !== 'string' || !value.ApiURL.trim()
    || !/^[^\s@]+@[^\s@]+$/.test(email) || !Array.isArray(agents) || agents.length === 0
    || agents.some(agent => !supportedAgents.includes(agent))) {
    throw new Error('Managed Doomer profile is incomplete.');
  }
  return { api: endpoint(value.ApiURL), email, key: value.EnrollmentKey, agents: [...new Set(agents)].sort() };
}

async function macProfile() {
  if (process.platform !== 'darwin' || process.getuid?.() === 0) throw new Error('Managed enrollment runs in a macOS user session.');
  return JSON.parse((await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', preferences], { maxBytes: 16 * 1024 })).toString());
}

function validCredential(credentials, savedAuth, profile, now) {
  return credentials?.api === profile.api && credentials.email === profile.email
    && credentials.agents?.join(',') === profile.agents.join(',')
    && savedAuth?.client_id === credentials.client_id && clientTokenPattern.test(savedAuth?.token)
    && Date.parse(savedAuth.expires_at) > now + 10 * 60 * 1000;
}

// The profile is read before every managed hook. Enrollment is retried with a
// stable install ID and uses a separate credential store from ordinary setup.
export async function enrollManaged(profile, { home, request = fetch, now = Date.now() } = {}) {
  const file = join(home, 'state.json');
  const lock = join(home, 'enrollment');
  const credentialDirectory = join(home, 'credentials');
  const credentialFile = join(credentialDirectory, 'config.json');
  const authKey = `auth:v2:${Buffer.byteLength(profile.api)}:${profile.api}:default`;
  const enroll = async () => {
    const previous = await readJSON(file, null);
    const identityFile = join(home, 'installation.json');
    const identity = await readJSON(identityFile, null) ?? { id: randomUUID(), api: profile.api, email: profile.email };
    if (!uuid.test(identity.id) || identity.api !== profile.api || identity.email !== profile.email) {
      throw new Error('Managed Doomer assignment changed. Ask IT to reprovision this installation.');
    }
    const saved = await readJSON(credentialFile, null);
    if (validCredential(previous?.managed, saved?.auths?.[authKey], profile, now)) return previous.managed;
    await writeJSON(identityFile, identity);
    const response = await request(profile.api + '/v1/auth/mdm/enroll', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(12000),
      headers: { authorization: 'Bearer ' + profile.key, 'content-type': 'application/json' },
      body: JSON.stringify({ email: profile.email, installation_id: identity.id, agents: profile.agents }),
    });
    if (!response.ok) throw new Error(response.status === 403 ? 'Managed Doomer enrollment denied.' : 'Managed Doomer enrollment unavailable.');
    const credential = await response.json();
    if (!clientTokenPattern.test(credential.token) || !uuid.test(credential.client_id) || !(Date.parse(credential.expires_at) > now)) {
      throw new Error('Managed Doomer received an invalid credential.');
    }
    const managed = {
      client_id: credential.client_id,
      api: profile.api, email: profile.email, agents: profile.agents,
    };
    await writeJSON(credentialFile, { auths: { [authKey]: {
      token: credential.token, client_id: credential.client_id, expires_at: credential.expires_at,
    } } });
    await writeJSON(file, {
      version: 1, api: profile.api, managed,
      credentialDirs: { [profile.api]: credentialDirectory },
      grants: [{ scope: 'global', api: profile.api, approvedAt: new Date(now).toISOString() }],
    });
    return managed;
  };
  return waitForManagedLock(lock, enroll);
}

// The launch agent and first hook can arrive together. Let the second
// operation use the state committed by the first.
async function waitForManagedLock(lock, operation) {
  const deadline = Date.now() + 14000;
  for (;;) {
    try { return await locked(lock, operation); }
    catch (error) {
      if (error.message !== `Another Doomer operation holds ${lock}.lock`) throw error;
      if (Date.now() >= deadline) throw new Error('Managed Doomer setup is already in progress.');
      await delay(100);
    }
  }
}

export function managedAgentConfig(agent, root = managedDirectory) {
  if (!supportedAgents.includes(agent)) throw new Error('Choose codex or claude.');
  const command = `${join(root, 'node')} ${join(root, 'manager', 'bin', 'doomer.js')} mdm-hook --agent ${agent}`;
  const config = { hooks: Object.fromEntries(eventsFor(agent).map(event => [
    event, [{ hooks: [{ type: 'command', command, timeout: event === 'Stop' ? 75 : 45 }] }],
  ])) };
  if (agent === 'claude') {
    const executable = join(root, 'doomer');
    config.permissions = { allow: claudeReviewRules(executable) };
    config.autoMode = { allow: ['$defaults', `Allow only ${executable} watch hypotheses, findings respond, findings ls, results, or notice-ack with an active --control key for Doomer reviews. Preserve explicit denials.`] };
  }
  return config;
}

async function configureManagedCodexPolicy(executable, profile, home, execute, env) {
  const base = ['--api-url', profile.api, 'watch', 'codex-policy', '--manager-home', resolve(home)];
  const options = { cwd: home, env, maxBytes: 1024 * 1024 };
  const inspect = async () => JSON.parse((await execute(executable, base, options)).toString()).policies;
  const policies = await inspect();
  if (!Array.isArray(policies) || policies.length !== 1 || policies[0].state === 'declined') {
    throw new Error('Managed Doomer Codex review policy is unavailable.');
  }
  if (policies[0].state === 'configured') return;
  const command = policies[0].install_command;
  const digest = Array.isArray(command) ? command[command.indexOf('--proposal') + 1] : null;
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Managed Doomer received an invalid Codex review policy.');
  await execute(executable, [...base, '--proposal', digest, '--decision', 'allow'], options);
  if (!(await inspect()).some(policy => policy.state === 'configured')) {
    throw new Error('Managed Doomer could not install the Codex review policy.');
  }
}

export async function managedCommand(command, agent, {
  readProfile = macProfile, root = managedDirectory,
  home = join(homedir(), 'Library', 'Application Support', 'Doomer MDM'),
  execute = run, request = fetch, input = readHookInput,
} = {}) {
  try {
    const hookInput = command === 'mdm-hook' ? await input() : null;
    const profile = parseManagedProfile(await readProfile());
    if (command === 'mdm-hook' && !profile.agents.includes(agent)) return {};
    const event = hookInput ? JSON.parse(hookInput.toString()).hook_event_name : null;
    if (event === null || event === 'UserPromptSubmit') await enrollManaged(profile, { home, request });
    else if (!await readJSON(join(home, 'state.json'), null)) return {};
    const env = { ...process.env };
    for (const name of ['DOOMER_TOKEN', 'DOOMER_CONFIG_DIR', 'DOOMER_PROFILE', 'DOOMER_API_URL']) delete env[name];
    const executable = join(root, 'doomer');
    if ((command === 'mdm-enroll' && profile.agents.includes('codex')) || (agent === 'codex' && event === 'UserPromptSubmit')) {
      await waitForManagedLock(join(home, 'codex-policy'), () => configureManagedCodexPolicy(executable, profile, home, execute, env));
    }
    if (command === 'mdm-enroll') return { status: 'enrolled', agents: profile.agents };
    const output = await execute(executable, [
      '--api-url', profile.api, 'watch', 'agent', '--agent', agent, '--manager-home', resolve(home),
    ], { env, input: hookInput });
    const result = JSON.parse(output.toString());
    if (result.managedDoomerError) throw new Error('Managed Doomer review could not start.');
    return result;
  } catch (error) {
    // System logs are for IT. Hook stdout stays valid JSON and the user is
    // never asked for consent, login, or a different agent.
    const message = error.message?.startsWith('Managed Doomer') ? error.message : 'Managed Doomer setup unavailable.';
    await execute('/usr/bin/logger', ['-t', 'doomer-mdm', message]).catch(() => {});
    if (command !== 'mdm-hook') throw new Error(message);
    return {};
  }
}

async function readHookInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('Managed Doomer hook input is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
