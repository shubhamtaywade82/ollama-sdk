import { describe, expect, it } from 'vitest';
import {
  connectMcpHttpClient,
  connectStreamableHttpMcpClient,
  connectSseMcpClient,
  type HttpMcpClientOptions,
} from '../src/mcp/http.js';

describe('MCP HTTP adapter', () => {
  it('exports explicit Streamable HTTP and legacy SSE connection helpers', () => {
    expect(connectMcpHttpClient).toEqual(expect.any(Function));
    expect(connectStreamableHttpMcpClient).toEqual(expect.any(Function));
    expect(connectSseMcpClient).toEqual(expect.any(Function));
  });

  it('validates the MCP URL before resolving the optional dependency', async () => {
    await expect(connectMcpHttpClient({ url: '' })).rejects.toThrow(
      'MCP HTTP server URL must be a valid absolute URL',
    );
  });

  it('rejects non-http protocols before resolving the optional dependency', async () => {
    await expect(
      connectMcpHttpClient({ url: 'file:///tmp/server' }),
    ).rejects.toThrow('MCP HTTP server URL must use http: or https:');
  });

  it('accepts a URL instance and request initialization options', () => {
    const options: HttpMcpClientOptions = {
      url: new URL('https://example.com/mcp'),
      requestInit: {
        headers: { Authorization: 'Bearer test' },
      },
      name: 'test-client',
      version: '1.2.3',
    };

    expect(options.url).toBeInstanceOf(URL);
    expect(options.requestInit?.headers).toEqual({ Authorization: 'Bearer test' });
  });
});
