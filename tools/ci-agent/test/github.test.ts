import { afterEach, describe, expect, it, vi } from 'vitest';
import { upsertReviewSummary } from '../src/github.js';

afterEach(() => vi.unstubAllGlobals());

describe('upsertReviewSummary', () => {
  it('updates the existing marker comment instead of creating another comment', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { id: 42, body: '<!-- ollama-ci-agent-review --> old', user: { type: 'Bot' } },
          ]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 42 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await upsertReviewSummary('owner/repo', 7, '<!-- ollama-ci-agent-review --> new', 'token');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://api.github.com/repos/owner/repo/issues/comments/42',
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      body: '<!-- ollama-ci-agent-review --> new',
    });
  });

  it('creates the marker comment when no previous bot summary exists', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ id: 12, body: 'Human comment', user: { type: 'User' } }]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 43 }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await upsertReviewSummary('owner/repo', 7, '<!-- ollama-ci-agent-review --> new', 'token');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://api.github.com/repos/owner/repo/issues/7/comments',
    );
  });
});
