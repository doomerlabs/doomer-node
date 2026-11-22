const runtimeCodes = new Set([
  'checkout_unavailable', 'codex_session_pending', 'codex_session_ready', 'codex_session_error',
  'hook_evidence_missing', 'hook_activity_recorded', 'review_completed', 'assessment_timed_out',
  'review_failed', 'review_status_recorded', 'review_evidence_missing', 'cli_changed_since_success',
  'installer_state_invalid', 'service_config_invalid', 'native_diagnostics_unavailable', 'collection_failed',
]);

export function doctorBrowserEndpoint(origin, code) {
  let url;
  try { url = new URL(origin); } catch {}
  const loopback = url && (url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname.startsWith('127.'));
  if (!url || origin !== url.origin || !/^[A-Za-z0-9_-]{43}$/.test(code ?? '') ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error('Copy a fresh Doctor command from the troubleshooting page.');
  }
  return new URL('/api/docs/doctor-session', url);
}

export async function sendDoctorBrowserResult(endpoint, code, result) {
  const checks = [
    ...(result.runtime?.report?.checks ?? []).map(check => check.code),
    ...(result.issues ?? []).map(issue => issue.code),
    result.runtime?.code,
  ].filter(code => runtimeCodes.has(code));
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'submit', code, result: { source: 'npm', ready: result.ready === true, checks: [...new Set(checks)].slice(0, 20) } }),
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
