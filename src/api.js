export const DEFAULT_API = 'https://doomer.ai/api';
export const resolveAPI = (explicit, saved, env = process.env) => endpoint(explicit || env.DOOMER_API_URL || saved || DEFAULT_API);
export function endpoint(value = DEFAULT_API) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('API URL must use HTTPS (HTTP is allowed only on loopback).');
  return url.href.replace(/\/$/, '');
}
