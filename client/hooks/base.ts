// The path the application is served under: '' at the root of a domain,
// '/demo' at example.com/demo. The server writes it into <base> in the page
// (server/index.ts, from PUBLIC_URL), so one build serves any path.
export const BASE = new URL(document.baseURI).pathname.replace(/\/$/, '');

/** An address of this application, from its path: '/api/avatars' -> '/demo/api/avatars'. */
export function url(path: string): string {
  return BASE + path;
}

/**
 * The name of something kept in the browser. Storage belongs to the whole
 * domain: two installations on one must not share an outbox or a saved cache.
 */
export function storageKey(name: string): string {
  return BASE ? `${name}:${BASE}` : name;
}
