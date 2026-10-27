# ADR 0041: Vision resolution trust boundaries and resource limits

**Status**: Accepted
**Date**: 2026-10-27

## Context

`src/vision.ts` normalizes polymorphic `images` entries (base64 strings, data URIs,
`http(s)` URLs, local file paths, raw bytes) into the raw base64 Ollama's REST API
requires. A production-readiness audit (2026-10-27) flagged the remote/local resolution
paths as a trust-boundary problem whenever an SDK consumer — a web service, an
autonomous agent, an MCP server — passes input it does not fully control into
`images`:

- URL resolution used the platform's **global** `fetch`, bypassing the client's
  configured `fetch` (proxies, custom agents, mocks) and the control points it carries.
- Remote bodies were buffered whole via `arrayBuffer()` with **no byte limit** — an
  oversized response allocated unbounded memory before anyone could object.
- There was **no fetch timeout**, **no redirect cap**, and no way to restrict which
  hosts may be fetched from. A URL like `http://169.254.169.254/…` (cloud metadata) or
  `http://localhost:8080/admin` was fetched happily — textbook SSRF when image URLs
  come from untrusted input. Redirects made it worse: the original URL's host says
  nothing about the redirect target's.
- A local-path read that **failed fell back silently** to shipping the raw path string
  to the server as if it were base64. The server can only reject it, so the fallback
  masked the real failure — and an extension-matched string can never *be* valid
  base64 anyway: the alphabet has no `.`.

## Decisions

1. **One policy object, threaded from the client.** `OllamaClientConfig.imageResolution`
   (`ImageResolutionPolicy`) configures every resolution path. `chat()`/`generate()`
   apply it automatically; the exported `resolveImageInput`/`resolveImages` accept it
   as an optional third argument (backward-compatible).
2. **The configured fetch is the resolver's fetch.** Remote image fetches default to
   the client's own `fetch` (`config.fetch`), so anything the consumer installed there
   applies to image resolution too. An explicit `policy.fetchImpl` wins.
3. **Resource limits enforced where they bite.**
   - `maxImageBytes` (default 50 MiB) caps remote bodies **while streaming** — the
     oversize error fires as soon as the limit is crossed and the download is
     cancelled, not after buffering — plus data-URI payloads (decoded-size estimate)
     and local file reads (`stat` before the read). Direct `Uint8Array`/`Buffer`
     inputs are deliberately **not** capped: the caller already holds those bytes; the
     hazard being fixed is resolution *amplifying* input, not passing through what is
     already in memory.
   - `fetchTimeoutMs` (default 30 s) covers the whole fetch — connection, redirects,
     and body read — and combines with the caller's request `signal` (either aborts).
   - `maxRedirects` (default 5).
4. **SSRF guard on by default.** `allowPrivateNetworkAccess: false` (the default)
   refuses loopback, private, CGNAT, link-local, benchmarking, documentation (TEST-NET),
   multicast/reserved/broadcast IPv4 ranges; the IPv6 equivalents (`::`, `::1`,
   `fc00::/7`, `fe80::/10`, `ff00::/8`, IPv4-mapped `::ffff:0:0/96`, NAT64
   `64:ff9b::/96`, documentation `2001:db8::/32`); `localhost`/`.local`/`.internal`/
   `.home.arpa` hostnames; and digit-and-dot strings that are not strict IPv4 (partial
   numeric forms some resolvers coerce — fail closed). Non-literal hostnames are
   classified via `node:dns/promises` `lookup`; `addressLookup` is injectable (DoH,
   caches, tests); any private result blocks the fetch. **Every redirect hop is
   re-validated**: on Node, redirects are followed manually so each `Location` target
   passes the same checks (protocol `http(s)`-only, host allowlist, private-address
   guard). `allowedImageHosts` (exact / `*.wildcard` / `'*'`) layers an explicit
   allowlist on top.
   Known limits, accepted: the guard runs pre-connect, so a DNS-rebinding race between
   check and connect is out of scope for a client library (use `allowedImageHosts`
   where that matters); and in browsers/edge runtimes, `redirect: 'manual'` yields
   opaque responses, so the engine follows redirects itself and only the initial URL
   is validated.
5. **Local reads are an explicit, honest capability.** `allowLocalFileReads` (default
   `true`, the historical behavior) can switch them off entirely for untrusted input.
   A failed read throws `vision_path_read_failed` carrying the underlying `cause` —
   the old pass-through fallback is gone.
6. **New error codes, all on `OllamaClientError`:** `image_too_large`,
   `image_fetch_timeout`, `image_redirect_limit`, `image_host_not_allowed`,
   `image_private_address_blocked`, `image_unsupported_protocol`,
   `vision_local_reads_disabled`, `vision_path_read_failed`,
   `image_fetch_unavailable`; aborts driven by the caller's signal surface as
   `OllamaAbortError`. Every message names the knob that changes the behavior.

## Consequences

- Consumers that legitimately fetch private image hosts (an internal image service in
  the same subnet) opt in with `allowPrivateNetworkAccess: true` — a deliberate,
  documented one-line change; the error message says exactly that.
- Remote fetches now perform one DNS lookup for non-literal hostnames on Node —
  negligible next to the fetch that follows, and injectable when it isn't.
- The silent-fallback removal is a behavior change: code that "worked" by shipping
  garbage paths now fails loudly at the call site. That is the point.
- Everything stays edge-runtime-safe: `node:fs` and `node:dns/promises` remain
  dynamically imported behind runtime guards and hidden specifiers, so browser/edge
  bundles still resolve nothing Node at build time (ADR 0006's verification gate keeps
  enforcing this).
- 58 tests cover every error code, every guarded address class, redirect chains
  (absolute, relative, cross-protocol, and capped), streaming oversize, timeout,
  caller-signal abort, allowlist exact/wildcard/deny, DNS-path classification, file
  caps, and client-level policy threading — all hermetic: IP-literal hosts plus
  injected `fetchImpl`/`addressLookup`, zero network.
