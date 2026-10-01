/** An in-memory `fetch` for tests that must not touch the network: URL -> canned response, every call recorded. */

export interface FakeResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

export interface FakeCall {
  url: string;
  headers: Headers;
}

export type FakeRoutes = Record<string, FakeResponse | ((call: FakeCall) => FakeResponse)>;

export function fakeFetch(routes: FakeRoutes): { fetch: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const call: FakeCall = { url, headers: new Headers(init?.headers) };
    calls.push(call);
    const route = routes[url];
    const res = typeof route === 'function' ? route(call) : route;
    if (!res) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    const status = res.status ?? 200;
    const body = status >= 300 && status < 400 ? null : (res.body ?? '');
    return new Response(body as ConstructorParameters<typeof Response>[0], { status, headers: res.headers ?? { 'content-type': 'text/html; charset=utf-8' } });
  };
  return { fetch: impl as typeof fetch, calls };
}

/** A public address, so the SSRF guard lets `*.example` hosts through without DNS. */
export const publicLookup = async (): Promise<Array<{ address: string }>> => [{ address: '93.184.216.34' }];
