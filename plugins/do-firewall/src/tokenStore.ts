/**
 * The person's own DO token lives in sessionStorage: it is gone when the tab
 * closes, never leaves this browser except as the Authorization header to
 * api.digitalocean.com, and is never written to the cluster or logged.
 */
const KEY = 'do-firewall.token';

export function readToken(): string {
  try {
    return window.sessionStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export function writeToken(token: string): void {
  try {
    if (token) window.sessionStorage.setItem(KEY, token);
    else window.sessionStorage.removeItem(KEY);
  } catch {
    /* storage blocked: the token then lasts only for this page view */
  }
}
