import { DEFAULT_API, resolveAPI } from './api.js';

const diagnosticCodes = new Set([
  'checkout_unavailable', 'codex_session_pending', 'codex_session_ready', 'codex_session_error',
  'hook_evidence_missing', 'hook_activity_recorded', 'review_completed', 'assessment_timed_out',
  'review_failed', 'review_status_recorded', 'review_evidence_missing', 'cli_changed_since_success',
  'installer_state_invalid', 'service_config_invalid', 'native_diagnostics_unavailable', 'collection_failed',
  'installation_incomplete', 'cli_incompatible', 'hook_config_invalid', 'hooks_missing', 'hooks_disabled',
  'reviewer_policy_unavailable', 'reviewer_policy_declined', 'reviewer_policy_missing',
  'uploads_not_approved', 'command_not_on_path',
]);

export function doctorBrowserEndpoint(origin, configuredAPI) {
  let url;
  try { url = new URL(origin); } catch {}
  if (!url || origin !== url.origin) {
    throw new Error('Copy a fresh Doctor command from the troubleshooting page.');
  }
  const publicOrigin = new URL(DEFAULT_API).origin;
  if (origin !== publicOrigin && origin !== new URL(resolveAPI(configuredAPI)).origin) {
    throw new Error('Use the Doctor page for the Doomer service configured on this machine.');
  }
  return new URL('/api/docs/doctor-session', url);
}

export async function sendDoctorBrowserResult(endpoint, code, result) {
  const checks = [
    ...(result.runtime?.report?.checks ?? []).map(check => check.code),
    ...(result.issues ?? []).map(issue => issue.code),
    result.runtime?.code,
  ].filter(code => diagnosticCodes.has(code));
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'submit', code, result: { source: 'npm', ready: result.ready === true, checks: [...new Set(checks)] } }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error('Couldn’t reach Doomer Doctor. Paste the terminal result into the page.');
  }
  if (response.status !== 200) {
    throw new Error(`Doomer Doctor didn’t accept the result (HTTP ${response.status}). Copy a fresh command or paste the terminal result.`);
  }
  const receipt = await response.json().catch(() => null);
  if (receipt?.received !== true) throw new Error('Doomer Doctor didn’t confirm receipt. Paste the terminal result into the page.');
}
