/**
 * DNS-rebinding guard for the HTTP servers. A web page can make a browser send requests to `http://127.0.0.1:<port>` by giving
 * its own hostname a loopback address; such a request carries the attacker's hostname in `Host` (and `Origin`). While a server is
 * bound to loopback only local names are accepted (plus the hostnames in LOCALE_ALLOWED_HOSTS, for a reverse proxy on the same
 * machine that forwards its public Host). This is not authentication: when the operator binds a non-loopback address the guard
 * is off and a reverse proxy or network policy has to protect the server.
 */

const LOOPBACK_NAMES: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

/** The hostnames to accept for `bindHost`, or `undefined` when it is not a loopback address (no guard). */
export function allowedHostnamesFor(bindHost: string, env: NodeJS.ProcessEnv = process.env): readonly string[] | undefined {
  const host = bindHost.toLowerCase();
  const loopback = host === 'localhost' || host === '::1' || host === '[::1]' || host.startsWith('127.');
  if (!loopback) return undefined;
  const extra = (env['LOCALE_ALLOWED_HOSTS'] ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== '');
  return [...LOOPBACK_NAMES, ...extra];
}

function hostnameOf(value: string): string | undefined {
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

/** A request without `Host` cannot come from a browser, so it passes. */
export function hostAllowed(hostHeader: string | undefined, allowed: readonly string[]): boolean {
  if (hostHeader === undefined) return true;
  const hostname = hostnameOf(`http://${hostHeader}`);
  return hostname !== undefined && allowed.includes(hostname);
}

/** `Origin` is only sent by browsers; when present it must be a local page (`Origin: null` is refused). */
export function originAllowed(originHeader: string | undefined, allowed: readonly string[]): boolean {
  if (originHeader === undefined) return true;
  const hostname = hostnameOf(originHeader);
  return hostname !== undefined && allowed.includes(hostname);
}

export function guardRejects(headers: { host?: string | undefined; origin?: string | undefined }, allowed: readonly string[]): boolean {
  return !hostAllowed(headers.host, allowed) || !originAllowed(headers.origin, allowed);
}

export const GUARD_MESSAGE =
  'this server is bound to loopback and only answers requests addressed to localhost, 127.0.0.1 or [::1]; ' +
  'a reverse proxy that forwards another Host needs it listed in LOCALE_ALLOWED_HOSTS (comma-separated hostnames)';
