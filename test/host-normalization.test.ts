import { describe, expect, it } from 'vitest';
import { isEnvApiKeyHost, normalizeBaseUrl } from '../src/transport/host.js';

describe('normalizeBaseUrl', () => {
  it.each([
    ['127.0.0.1:11434', 'http://127.0.0.1:11434'],
    ['0.0.0.0:11434', 'http://0.0.0.0:11434'],
    [':11434', 'http://127.0.0.1:11434'],
    ['myhost', 'http://myhost:11434'],
    ['myhost:8080', 'http://myhost:8080'],
    ['myhost:443', 'https://myhost'],
    ['[::1]:11434', 'http://[::1]:11434'],
    ['http://env-host:9999', 'http://env-host:9999'],
    ['http://env-host:9999///', 'http://env-host:9999'],
    ['https://ollama.com', 'https://ollama.com'],
    ['http://myhost', 'http://myhost'],
    ['  http://localhost:11434/  ', 'http://localhost:11434'],
    ['proxy.internal:8080/ollama/', 'http://proxy.internal:8080/ollama'],
    ['https://proxy.internal/ollama', 'https://proxy.internal/ollama'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeBaseUrl(input)).toBe(expected);
  });

  it('is idempotent', () => {
    for (const input of ['127.0.0.1:11434', ':11434', 'myhost:443', 'https://ollama.com/']) {
      const once = normalizeBaseUrl(input);
      expect(normalizeBaseUrl(once)).toBe(once);
    }
  });

  it('returns empty and unparseable input trimmed rather than throwing', () => {
    expect(normalizeBaseUrl('   ')).toBe('');
    expect(normalizeBaseUrl('http://[bad')).toBe('http://[bad');
  });
});

describe('isEnvApiKeyHost', () => {
  it.each([
    'https://ollama.com',
    'https://api.ollama.com',
    'http://localhost:11434',
    'localhost:11434',
    '127.0.0.1:11434',
    'http://127.5.5.5:11434',
    ':11434',
    'http://[::1]:11434',
    'http://0.0.0.0:11434',
  ])('allows %s', (url) => {
    expect(isEnvApiKeyHost(url)).toBe(true);
  });

  it.each([
    'https://api.third-party.example',
    'http://192.168.1.10:11434',
    'https://notollama.com',
    'https://ollama.com.evil.example',
    'https://evil.example/ollama.com',
    'http://127.0.0.1.evil.example',
  ])('rejects %s', (url) => {
    expect(isEnvApiKeyHost(url)).toBe(false);
  });
});
