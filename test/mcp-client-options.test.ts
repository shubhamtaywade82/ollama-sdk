import { describe, expect, it, vi } from 'vitest';
import { registerElicitationHandlers } from '../src/mcp/client-options.js';
import type { McpClientRequestHandler } from '../src/mcp/client-options.js';

describe('MCP client elicitation setup', () => {
  it('declares only configured elicitation modes and routes form requests', async () => {
    const registerCapabilities = vi.fn();
    const setRequestHandler = vi.fn();
    const form = vi.fn().mockResolvedValue({
      action: 'accept',
      content: { name: 'Ada' },
    });
    const client: McpClientRequestHandler = { registerCapabilities, setRequestHandler };

    registerElicitationHandlers(client, { form });

    expect(registerCapabilities).toHaveBeenCalledWith({ elicitation: { form: {} } });
    expect(setRequestHandler).toHaveBeenCalledTimes(1);
    const handler = setRequestHandler.mock.calls[0]![1];
    const request = {
      mode: 'form' as const,
      message: 'Name?',
      requestedSchema: { type: 'object', properties: { name: { type: 'string' } } },
    };
    await expect(handler({ params: request })).resolves.toEqual({
      action: 'accept',
      content: { name: 'Ada' },
    });
    expect(form).toHaveBeenCalledWith(request);
  });

  it('routes URL requests only to the configured URL handler', async () => {
    const client: McpClientRequestHandler = {
      registerCapabilities: vi.fn(),
      setRequestHandler: vi.fn(),
    };
    const url = vi.fn().mockResolvedValue({ action: 'accept' });
    registerElicitationHandlers(client, { url });

    const handler = client.setRequestHandler;
    expect(handler).toBeDefined();
    const callback = vi.mocked(handler!).mock.calls[0]![1];
    const request = {
      mode: 'url' as const,
      message: 'Authorize',
      url: 'https://example.com/auth',
      elicitationId: 'id-1',
    };
    await expect(callback({ params: request })).resolves.toEqual({ action: 'accept' });
    expect(url).toHaveBeenCalledWith(request);
  });

  it('fails explicitly when a server requests a mode with no configured handler', async () => {
    const client: McpClientRequestHandler = {
      registerCapabilities: vi.fn(),
      setRequestHandler: vi.fn(),
    };
    registerElicitationHandlers(client, { form: () => ({ action: 'decline' }) });

    const callback = vi.mocked(client.setRequestHandler!).mock.calls[0]![1];
    await expect(
      callback({
        params: {
          mode: 'url',
          message: 'Authorize',
          url: 'https://example.com/auth',
          elicitationId: 'id-2',
        },
      }),
    ).rejects.toThrow('no URL handler is configured');
  });

  it('rejects empty handler configuration and clients without handler support', () => {
    expect(() => registerElicitationHandlers({}, {})).toThrow(
      'At least one MCP elicitation handler must be provided',
    );
    expect(() =>
      registerElicitationHandlers(
        {},
        {
          form: () => ({ action: 'cancel' }),
        },
      ),
    ).toThrow('does not support elicitation');
  });
});
