import { Buffer } from 'node:buffer';

const GITHUB_API = 'https://api.github.com';

interface RequestOpts {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export async function requestGitHub<T>(
  path: string,
  token: string,
  opts: RequestOpts = {},
): Promise<T> {
  const url = path.startsWith('http') ? path : `${GITHUB_API}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'ci-agent',
    ...opts.headers,
  };

  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers,
  };

  if (opts.body !== undefined) {
    init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, init);
  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`GitHub API error ${res.status} on ${path}: ${errorText}`);
  }

  if (headers.Accept?.includes('vnd.github.diff')) {
    return (await res.text()) as unknown as T;
  }
  return res.json() as Promise<T>;
}

export async function fetchPrDiff(repo: string, prNumber: number, token: string): Promise<string> {
  return requestGitHub<string>(`/repos/${repo}/pulls/${prNumber}`, token, {
    headers: { Accept: 'application/vnd.github.diff' },
  });
}

export interface ReviewCommentPayload {
  path: string;
  line: number;
  body: string;
}

export async function postReview(
  repo: string,
  prNumber: number,
  body: string,
  comments: ReviewCommentPayload[],
  token: string,
): Promise<void> {
  await requestGitHub(`/repos/${repo}/pulls/${prNumber}/reviews`, token, {
    method: 'POST',
    body: {
      body,
      event: 'COMMENT', // Advisory only — never approve or request changes
      comments,
    },
  });
}

export async function createBranch(
  repo: string,
  branch: string,
  sha: string,
  token: string,
): Promise<void> {
  await requestGitHub(`/repos/${repo}/git/refs`, token, {
    method: 'POST',
    body: { ref: `refs/heads/${branch}`, sha },
  });
}

export async function updateBranchFile(
  repo: string,
  branch: string,
  filePath: string,
  content: string,
  message: string,
  token: string,
): Promise<void> {
  let fileSha: string | undefined;
  try {
    const existing = await requestGitHub<{ sha: string }>(
      `/repos/${repo}/contents/${filePath}?ref=${branch}`,
      token,
    );
    fileSha = existing.sha;
  } catch {
    // New file creation does not have an existing sha
  }

  await requestGitHub(`/repos/${repo}/contents/${filePath}`, token, {
    method: 'PUT',
    body: {
      message,
      content: Buffer.from(content).toString('base64'),
      branch,
      sha: fileSha,
    },
  });
}

export async function createDraftPr(
  repo: string,
  title: string,
  head: string,
  base: string,
  body: string,
  token: string,
): Promise<number> {
  const result = await requestGitHub<{ number: number }>(`/repos/${repo}/pulls`, token, {
    method: 'POST',
    body: { title, head, base, body, draft: true },
  });
  return result.number;
}


export async function upsertReviewSummary(
  repo: string,
  prNumber: number,
  body: string,
  token: string,
): Promise<void> {
  const marker = '<!-- ollama-ci-agent-review -->';
  const comments = await requestGitHub<Array<{ id: number; body?: string; user?: { type?: string } }>>(
    `/repos/${repo}/issues/${prNumber}/comments?per_page=100`,
    token,
  );
  const existing = comments.find((comment) =>
    comment.body?.includes(marker) && comment.user?.type === 'Bot',
  );
  if (existing) {
    await requestGitHub(`/repos/${repo}/issues/comments/${existing.id}`, token, {
      method: 'PATCH',
      body: { body },
    });
    return;
  }
  await requestGitHub(`/repos/${repo}/issues/${prNumber}/comments`, token, {
    method: 'POST',
    body: { body },
  });
}
