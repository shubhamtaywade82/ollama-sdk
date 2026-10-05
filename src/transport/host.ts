/**
 * Host normalization and credential-scoping helpers for Ollama base URLs.
 *
 * `OLLAMA_HOST` is conventionally written as a bare `host:port` (`127.0.0.1:11434`,
 * `0.0.0.0`, `:11434`), not a full URL — the official `ollama` CLI and client libraries
 * accept all of those. `fetch` does not, so every base URL is normalized before use.
 */

const DEFAULT_PORT = '11434';
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Normalizes an Ollama host string into a base URL without a trailing slash.
 *
 * - An explicit scheme is kept as-is (`https://host`, `http://host:9999`).
 * - A missing scheme defaults to `http://`; a missing port on a scheme-less host defaults
 *   to `11434`, except that port `443` with no scheme selects `https://` (port dropped).
 * - A leading `:port` means localhost (`:11434` → `http://127.0.0.1:11434`).
 * - A path prefix (reverse proxy mount) is preserved.
 * - Input that cannot be parsed is returned trimmed so the failure surfaces at request time
 *   exactly as it did before normalization existed.
 */
export function normalizeBaseUrl(host: string): string {
  const trimmed = host.trim();
  if (trimmed === '') return trimmed;

  const implicitScheme = !SCHEME_RE.test(trimmed);
  const withHost = trimmed.startsWith(':') ? `127.0.0.1${trimmed}` : trimmed;
  const candidate = implicitScheme ? `http://${withHost}` : withHost;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return trimmed.replace(/\/+$/, '');
  }

  let protocol = url.protocol;
  let port = url.port;
  if (implicitScheme) {
    if (port === '443') {
      protocol = 'https:';
      port = '';
    } else if (port === '') {
      port = DEFAULT_PORT;
    }
  }

  const authority = `${url.hostname}${port !== '' ? `:${port}` : ''}`;
  return `${protocol}//${authority}${url.pathname}`.replace(/\/+$/, '');
}

/**
 * Whether an environment-sourced credential (`OLLAMA_API_KEY`) may be sent to `baseUrl`.
 *
 * Only Ollama Cloud (`ollama.com` and subdomains) and loopback hosts qualify. An ambient
 * env var must not silently follow `baseUrl` to an arbitrary third-party host; callers who
 * want a key sent elsewhere pass `apiKey` (or per-endpoint `apiKey`) explicitly.
 */
export function isEnvApiKeyHost(baseUrl: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(normalizeBaseUrl(baseUrl)).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname === 'ollama.com' || hostname.endsWith('.ollama.com')) return true;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (hostname === '[::1]' || hostname === '::1' || hostname === '0.0.0.0') return true;
  return /^127(?:\.\d{1,3}){3}$/.test(hostname);
}
