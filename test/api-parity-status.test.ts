import { describe, expect, it } from 'vitest';
import {
  docsMentionField,
  explicitlyUnsupported,
  firstKnownStatus,
  nestedFieldName,
  endpointSection,
  supportedFeatureStatus,
} from '../scripts/parity-status.js';

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
