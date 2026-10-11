import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  markdownDocsUrl,
  requestFieldSection,
  docsMentionField,
  explicitlyUnsupported,
  firstKnownStatus,
  nestedFieldName,
  endpointSection,
  supportedFeatureStatus,
} from '../generator/parser/docs-fetcher.js';

describe('API parity documentation evidence', () => {
  it('does not let a stale fallback promote a missing live field', () => {
    const liveSection = [
      'Supported request fields',
      '- [Input] `model`',
      '- [Input] `messages`',
    ].join('\n');
    const staleFallback = [
      'Supported request fields',
      '- [Input] `output_config`',
    ].join('\n');

    expect(firstKnownStatus(liveSection, staleFallback, ['output_config'])).toBe('missing');
  });

  it('uses the pinned fallback when the live section is unavailable', () => {
    const staleFallback = [
      'Supported request fields',
      '- [Input] `output_config`',
    ].join('\n');

    expect(firstKnownStatus('', staleFallback, ['output_config'])).toBe('supported');
  });

  it('preserves explicit unsupported status from the live section', () => {
    const liveSection = [
      'Not supported',
      '- [ ] `tool_choice`',
    ].join('\n');
    const staleFallback = [
      'Supported request fields',
      '- [Input] `tool_choice`',
    ].join('\n');

    expect(firstKnownStatus(liveSection, staleFallback, ['tool_choice'])).toBe('unsupported');
  });
});

describe('API parity endpoint extraction', () => {
  it('selects the actual Responses endpoint instead of the earlier code-example heading', () => {
    const docs = [
      '### Simple /v1/responses example',
      'curl http://localhost:11434/v1/responses',
      '## Responses API',
      'POST /v1/responses',
      '#### Supported request fields',
      '- [Input] `model`',
      '- [Input] `reasoning`',
      '  - [Input] `effort`',
      '- [Input] `think`',
      '## Models',
    ].join('\n');

    const section = endpointSection(docs, '/v1/responses');
    expect(section).toContain('- [Input] `reasoning`');
    expect(section).toContain('- [Input] `think`');
    expect(section).not.toContain('curl http://localhost:11434/v1/responses');
  });
});

describe('API parity unsupported evidence', () => {
  it('recognizes fields listed in an unsupported table', () => {
    expect(
      docsMentionField(
        [
          'Not supported',
          'Feature | Description',
          '--- | ---',
          'tool_choice | Forcing a specific tool',
        ].join('\n'),
        ['tool_choice'],
      ),
    ).toBe(true);
  });

  it('recognizes explicit unsupported prose', () => {
    expect(
      explicitlyUnsupported(
        'Prompt caching via `cache_control` blocks is not supported.',
        ['cache_control'],
      ),
    ).toBe(true);
  });

  it('extracts the leaf field from a nested contract path', () => {
    expect(nestedFieldName('messages[].content[].cache_control')).toBe('cache_control');
  });
});


describe('API parity supported feature evidence', () => {
  it('recognizes supported features that are documented outside request-field tables', () => {
    const docs = [
      '#### Supported features',
      '  * [Input] Logprobs',
      '#### Supported request fields',
      '  * [Input] `model`',
    ].join('\n');

    expect(supportedFeatureStatus(docs, ['Logprobs'])).toBe('supported');
  });
});

describe('API parity against the pinned markdown docs (checkbox state)', () => {
  const openaiDocs = readFileSync(
    resolve(import.meta.dirname, '../docs/upstream/ollama-openai-compatibility.mdx'),
    'utf8',
  );
  const anthropicDocs = readFileSync(
    resolve(import.meta.dirname, '../docs/upstream/ollama-anthropic-compatibility.mdx'),
    'utf8',
  );

  const status = (docs: string, endpoint: string, field: string) =>
    firstKnownStatus(requestFieldSection(docs, endpoint), '', [field]);

  it('scopes an endpoint section to its own heading level (backticked Mintlify headings)', () => {
    const chat = endpointSection(openaiDocs, '/v1/chat/completions');
    expect(chat).toContain('`reasoning_effort`');
    expect(chat).not.toContain('`suffix`');
    expect(chat).not.toContain('`encoding format`');
  });

  it('reads unchecked `[ ]` items as explicitly unsupported', () => {
    for (const field of ['tool_choice', 'logit_bias', 'user', 'n']) {
      expect(status(openaiDocs, '/v1/chat/completions', field)).toBe('unsupported');
    }
    for (const field of ['best_of', 'echo', 'logit_bias', 'user', 'n']) {
      expect(status(openaiDocs, '/v1/completions', field)).toBe('unsupported');
    }
    expect(status(openaiDocs, '/v1/embeddings', 'user')).toBe('unsupported');
    for (const field of ['previous_response_id', 'conversation', 'truncation']) {
      expect(status(openaiDocs, '/v1/responses', field)).toBe('unsupported');
    }
    for (const field of ['tool_choice', 'metadata']) {
      expect(status(anthropicDocs, '/v1/messages', field)).toBe('unsupported');
    }
  });

  it('reads checked `[x]` items as supported', () => {
    for (const field of ['model', 'messages', 'tools', 'reasoning_effort', 'stream_options']) {
      expect(status(openaiDocs, '/v1/chat/completions', field)).toBe('supported');
    }
    expect(status(openaiDocs, '/v1/completions', 'suffix')).toBe('supported');
    expect(status(openaiDocs, '/v1/responses', 'think')).toBe('supported');
    expect(status(anthropicDocs, '/v1/messages', 'output_config')).toBe('supported');
  });

  it('reads an unchecked feature item as unsupported', () => {
    expect(
      supportedFeatureStatus(endpointSection(openaiDocs, '/v1/chat/completions'), ['Logprobs']),
    ).toBe('unsupported');
    expect(supportedFeatureStatus(['#### Supported features', '* [x] Vision'].join('\n'), ['Vision'])).toBe(
      'supported',
    );
  });
});

describe('markdownDocsUrl', () => {
  it('maps docs.ollama.com pages to their markdown twin', () => {
    expect(markdownDocsUrl('https://docs.ollama.com/api/openai-compatibility')).toBe(
      'https://docs.ollama.com/api/openai-compatibility.md',
    );
    expect(markdownDocsUrl('https://docs.ollama.com/api#web-search')).toBe(
      'https://docs.ollama.com/api.md',
    );
  });

  it('leaves non-docs hosts and explicit files alone', () => {
    expect(markdownDocsUrl('https://example.com/api/chat')).toBeUndefined();
    expect(markdownDocsUrl('https://docs.ollama.com/openapi.yaml')).toBeUndefined();
    expect(markdownDocsUrl('https://docs.ollama.com/api/chat.md')).toBeUndefined();
  });
});
