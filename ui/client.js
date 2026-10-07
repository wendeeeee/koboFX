const SESSION_KEY = 'kobofx.session';
let session;
try { session = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { session = null; }
let refreshing;
export function getSession() { return session; }
export function setSession(value) {
  session = value;
  if (value) sessionStorage.setItem(SESSION_KEY, JSON.stringify(value));
  else { sessionStorage.removeItem(SESSION_KEY); sessionStorage.removeItem('kobofx.funding'); sessionStorage.removeItem('kobofx.trade'); }
}
const messages = {
  UI_BACKEND_UNAVAILABLE: 'We can’t reach your wallet right now. Please try again shortly.',
  INVALID_CREDENTIALS: 'Check your email and password. If you just signed up, verify your email first.',
  VERIFICATION_FAILED: 'That code or password didn’t match. Check your latest email and try again.',
  RATE_LIMITED: 'A few too many attempts. Please wait a moment before trying again.',
  UNAUTHENTICATED: 'Your session has ended. Please sign in again.',
  ACCOUNT_SUSPENDED: 'Your account is temporarily unavailable. Please contact the person helping you try KoboFX.',
  FX_RATE_STALE: 'We’re refreshing our exchange rates. Please try again shortly.',
  FX_RATE_UNAVAILABLE: 'Exchange rates are temporarily unavailable. Your money is safe in your wallet.',
  QUOTE_EXPIRED: 'This quote has expired. Get a fresh quote before exchanging.',
  INSUFFICIENT_FUNDS: 'There isn’t enough available money in this wallet. Add money or try a smaller amount.',
  FUNDS_RESERVED: 'Some of this balance is already in use. Please try a smaller amount.',
  DAILY_LIMIT_EXCEEDED: 'You’ve reached today’s limit. Please try again tomorrow.',
  AMOUNT_TOO_SMALL: 'This amount is below the minimum. Please enter a larger amount.',
  AMOUNT_TOO_LARGE: 'This amount is above the limit. Please try a smaller amount.',
  REQUEST_IN_PROGRESS: 'We’re still processing this request. Please wait a moment, then try again.',
  DEPENDENCY_UNAVAILABLE: 'This service is temporarily unavailable. Please try again shortly.',
  WITHDRAWAL_CODE_INVALID: 'That code didn’t work. It may be wrong, expired or already used. Tap “Send code” for a new one.',
  WITHDRAWALS_DISABLED: 'Withdrawals are paused right now. Your money is safe in your wallet. Please try again later.',
  BENEFICIARY_NOT_READY: 'We’re still checking that bank account. Please wait until it shows as Ready.',
  WITHDRAWAL_BENEFICIARY_NOT_FOUND: 'We couldn’t find that bank account. Please add it again.',
  UNSUPPORTED_CURRENCY: 'Withdrawals are in naira only.',
};
export class ApiError extends Error {
  constructor(body, status) { super(messages[body.code] || (status === 404 ? 'This service isn’t available yet. Please check with the person helping you try KoboFX.' : 'We couldn’t complete that request. Please try again.')); this.code = body.code; this.status = status; this.details = body.details; }
}
export async function api(path, { method = 'GET', body, key, anonymous = false, retry = true } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (!anonymous && session?.tokens) headers.Authorization = `Bearer ${session.tokens.access.token}`;
  if (key) headers['Idempotency-Key'] = key;
  let response;
  try { response = await fetch(`/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(25000) }); }
  catch { throw new ApiError({ code: 'UI_BACKEND_UNAVAILABLE' }, 503); }
  if (response.status === 401 && !anonymous && retry && session?.tokens?.refresh) {
    if (!refreshing) refreshing = api('/auth/refresh', { method: 'POST', body: { refreshToken: session.tokens.refresh.token }, anonymous: true, retry: false })
      .then((data) => { if (session) setSession({ ...session, tokens: data.tokens }); })
      .catch((error) => { setSession(null); window.dispatchEvent(new Event('session-ended')); throw error; })
      .finally(() => { refreshing = null; });
    await refreshing;
    return api(path, { method, body, key, anonymous, retry: false });
  }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data, response.status);
  return data;
}
