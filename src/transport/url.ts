/**
 * Request URL assembly for the HTTP transport.
 *
 * Ollama is frequently deployed behind a reverse proxy under a path prefix
 * (`https://gateway.internal.corp/ai/ollama`). The transport therefore joins
 * base URLs and request paths by explicit string concatenation — never via
 * `new URL(path, base)`, whose WHATWG semantics discard the base's path
 * segments whenever the path is absolute (`new URL('/api/chat', base)`).
 *
 * {@link joinUrlPath} is the single place that owns the join, so the
 * "exactly one slash between the base and the path" invariant holds even if
 * a base URL slips through with a trailing slash or a future call site
 * passes a path without its leading slash.
 */

/**
 * Joins a base URL and a request path with exactly one slash.
 *
 * - Any number of trailing slashes on `baseUrl` and leading slashes on
 *   `path` are collapsed, so `https://host/ai/ollama/` + `/api/chat`,
 *   `https://host/ai/ollama` + `/api/chat`, and `https://host/ai/ollama`
 *   + `api/chat` all produce `https://host/ai/ollama/api/chat` — a proxy
 *   mount prefix is always preserved.
 * - A path may carry a query string (`/api/usage?bucket=24h`); it is
 *   concatenated untouched after the join.
 * - An empty path yields the base unchanged (trailing slashes stripped).
 */
export function joinUrlPath(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const tail = path.replace(/^\/+/, '');
  if (tail === '') return base;
  if (base === '') return `/${tail}`;
  return `${base}/${tail}`;
}
