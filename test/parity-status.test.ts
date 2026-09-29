import { describe, expect, it } from 'vitest';
import { docsFieldStatus, supportedFeatureStatus } from '../scripts/parity-status.js';

describe('API parity documentation status', () => {
  it('treats an explicitly listed supported feature as supported', () => {
    const docs = [
      '#### Supported features',
      '  * [Input] Logprobs',
      '#### Supported request fields',
      '  * [Input] `model`',
    ].join('\n');

    expect(docsFieldStatus('  * [Input] Logprobs', ['logprobs'])).toBe('supported');
    expect(supportedFeatureStatus(docs, ['Logprobs'])).toBe('supported');
  });

  it('does not promote unsupported or unrelated features', () => {
    const docs = [
      '#### Supported features',
      '  * [Input] Vision',
      '#### Supported request fields',
      '  * [Input] `model`',
    ].join('\n');

    expect(supportedFeatureStatus(docs, ['Logprobs'])).toBe('missing');
  });
});
