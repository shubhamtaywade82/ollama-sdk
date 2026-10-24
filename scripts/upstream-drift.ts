#!/usr/bin/env tsx
/**
 * Detect upstream drift for every pinned docs source (ADR 0039).
 *
 * For each docs-index.json source with an `upstreamPath`, compares the
 * pinned commit against the latest ollama/ollama commit touching that path.
 * Exits 1 when any pin is behind upstream, so the weekly upstream-watch
 * workflow can open the issue and the candidate re-pin PR.
 *
 * Usage:
 *   npm run contract:upstream-drift                  # print report
 *   npm run contract:upstream-drift -- --out <file>  # also write report
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const DOCS_INDEX_PATH = resolve(PROJECT_ROOT, 'contracts/sources/docs-index.json');
const GITHUB_REPO_API = 'https://api.github.com/repos/ollama/ollama';
// Bridge code moves ahead of the compatibility docs (ADR 0038 watch items);
// reported for human review, never counted as drift.
const CODE_WATCH_PATHS = ['openai', 'anthropic'] as const;
// Keep in sync with the version the conformance job in ci.yml installs.
const CONFORMANCE_OLLAMA_VERSION = 'v0.40.0';
const FETCH_TIMEOUT_MS = 30_000;

export interface DocsIndexSource {
  readonly id: string;
  readonly kind?: string;
  readonly path?: string | null;
  readonly upstream?: string;
  readonly upstreamPath?: string;
  readonly pinnedSha?: string;
  readonly pinnedAt?: string;
}

type TrackedSource = DocsIndexSource & {
  upstreamPath: string;
  pinnedSha: string;
  pinnedAt: string;
};

export interface UpstreamCommit {
  readonly sha: string;
  readonly subject: string;
  readonly date: string;
  readonly url: string;
}

export interface SourceDrift {
  readonly id: string;
  readonly upstreamPath: string;
  readonly pinnedSha: string;
  readonly latest: UpstreamCommit;
  readonly commits: readonly UpstreamCommit[];
}

interface GitHubCommit {
  sha: string;
  html_url: string;
  commit: { message: string; committer: { date: string } };
}

interface GitHubCompare {
  status: 'ahead' | 'behind' | 'identical' | 'diverged';
  base_commit: GitHubCommit;
}

interface DocsIndex {
  sources: DocsIndexSource[];
}

/** Parsed contracts/sources/docs-index.json. */
export function readDocsIndex(): DocsIndex {
  return JSON.parse(readFileSync(DOCS_INDEX_PATH, 'utf8')) as DocsIndex;
}

/** Record a source's new pin in docs-index.json (pin-consistency.test.ts checks it against the pin header). */
export function writePinToDocsIndex(id: string, sha: string, date: string): void {
  const index = readDocsIndex();
  const source = index.sources.find((candidate) => candidate.id === id);
  if (!source) throw new Error(`docs-index.json has no source "${id}"`);
  Object.assign(source, { pinnedSha: sha, pinnedAt: date });
  writeFileSync(DOCS_INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
}

async function githubJson<T>(endpoint: string): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  const token = process.env['GITHUB_TOKEN'];
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const url = `${GITHUB_REPO_API}${endpoint}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`GitHub API ${url} failed: HTTP ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

function toUpstreamCommit(commit: GitHubCommit): UpstreamCommit {
  return {
    sha: commit.sha,
    subject: commit.commit.message.split('\n')[0] ?? '',
    date: commit.commit.committer.date,
    url: commit.html_url,
  };
}

async function commitsTouching(path: string, since?: string): Promise<UpstreamCommit[]> {
  const query = new URLSearchParams({ path, per_page: '50' });
  if (since) query.set('since', since);
  const commits = await githubJson<GitHubCommit[]>(`/commits?${query.toString()}`);
  return commits.map(toUpstreamCommit);
}

/** Latest ollama/ollama main commit touching `path`. */
export async function latestUpstreamCommit(path: string): Promise<UpstreamCommit> {
  const [latest] = await commitsTouching(path);
  if (!latest) throw new Error(`No upstream commits found touching ${path}`);
  return latest;
}

async function driftForSource(source: TrackedSource): Promise<SourceDrift | undefined> {
  const latest = await latestUpstreamCommit(source.upstreamPath);
  // Compare by ancestry, not equality: a pin may be a main commit that did
  // not itself touch the file, and is still fresh if nothing newer did.
  const compare = await githubJson<GitHubCompare>(`/compare/${source.pinnedSha}...${latest.sha}`);
  if (compare.status !== 'ahead') return undefined;
  const pinDate = compare.base_commit.commit.committer.date;
  const commits = (await commitsTouching(source.upstreamPath, pinDate)).filter(
    (commit) => commit.sha !== source.pinnedSha,
  );
  return {
    id: source.id,
    upstreamPath: source.upstreamPath,
    pinnedSha: source.pinnedSha,
    latest,
    commits,
  };
}

function isTracked(source: DocsIndexSource): source is TrackedSource {
  return Boolean(source.upstreamPath && source.pinnedSha && source.pinnedAt);
}

/** Every tracked source whose pin is behind upstream. */
export async function findUpstreamDrift(
  sources: readonly DocsIndexSource[],
): Promise<SourceDrift[]> {
  const drifts: SourceDrift[] = [];
  for (const source of sources.filter(isTracked)) {
    const drift = await driftForSource(source);
    if (drift) drifts.push(drift);
  }
  return drifts;
}

function commitLine(commit: UpstreamCommit): string {
  return `- [\`${commit.sha.slice(0, 7)}\`](${commit.url}) ${commit.date.slice(0, 10)} — ${commit.subject}`;
}

function driftSection(drifts: readonly SourceDrift[]): string[] {
  if (drifts.length === 0) return ['No drift: every pinned source matches upstream.', ''];
  return drifts.flatMap((drift) => [
    `### \`${drift.id}\` (\`${drift.upstreamPath}\`)`,
    `Pinned \`${drift.pinnedSha.slice(0, 7)}\` → latest \`${drift.latest.sha.slice(0, 7)}\``,
    '',
    ...drift.commits.map(commitLine),
    '',
  ]);
}

async function codeWatchSection(sinceDate: string): Promise<string[]> {
  const lines = [`## Bridge code changes since ${sinceDate} (informational)`, ''];
  for (const path of CODE_WATCH_PATHS) {
    const commits = await commitsTouching(path, `${sinceDate}T00:00:00Z`);
    lines.push(`### \`${path}/\``, ...(commits.length ? commits.map(commitLine) : ['- none']), '');
  }
  return lines;
}

async function releaseSection(): Promise<string[]> {
  const release = await githubJson<{ tag_name: string }>('/releases/latest');
  const note = release.tag_name === CONFORMANCE_OLLAMA_VERSION ? 'matches' : 'differs from';
  return [
    '## Ollama release (informational)',
    '',
    `Latest release \`${release.tag_name}\` ${note} the conformance job's \`${CONFORMANCE_OLLAMA_VERSION}\`.`,
    '',
  ];
}

function oldestPinDate(sources: readonly DocsIndexSource[]): string {
  const dates = sources.filter(isTracked).map((source) => source.pinnedAt);
  return dates.sort()[0] ?? new Date().toISOString().slice(0, 10);
}

function writeGithubOutput(drifts: readonly SourceDrift[]): void {
  const outputPath = process.env['GITHUB_OUTPUT'];
  if (!outputPath) return;
  const openapi = drifts.find((drift) => drift.id === 'openapi');
  const lines = [
    `drifted=${drifts.map((drift) => drift.id).join(',')}`,
    `openapi_sha=${openapi?.latest.sha ?? ''}`,
  ];
  appendFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

function parseOutPath(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--out');
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value) throw new Error('--out requires a value');
  return value;
}

async function main(): Promise<void> {
  const outPath = parseOutPath(process.argv.slice(2));
  const index = readDocsIndex();
  const drifts = await findUpstreamDrift(index.sources);
  const report = [
    '## Upstream docs drift',
    '',
    ...driftSection(drifts),
    ...(await codeWatchSection(oldestPinDate(index.sources))),
    ...(await releaseSection()),
  ].join('\n');
  console.log(report);
  if (outPath) writeFileSync(outPath, report, 'utf8');
  writeGithubOutput(drifts);
  if (drifts.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error('contract:upstream-drift FAILED:');
    console.error(error);
    process.exitCode = 2;
  });
}
