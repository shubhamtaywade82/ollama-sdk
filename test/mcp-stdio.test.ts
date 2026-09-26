import { describe, expect, it } from 'vitest';
import { connectStdioMcpClient } from '../src/mcp/stdio.js';

describe('MCP stdio adapter', () => {
  it('is exposed as a separate Node-oriented adapter without loading an MCP transport at import time', () => {
    expect(connectStdioMcpClient).toEqual(expect.any(Function));
  });

  it('validates an empty command before resolving the optional dependency', async () => {
    await expect(connectStdioMcpClient({ command: '' })).rejects.toThrow(
      'MCP stdio server command must be a non-empty string',
    );
  });
});
