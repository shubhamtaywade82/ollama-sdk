import type {
  McpElicitationFormRequest,
  McpElicitationHandlers,
  McpElicitationRequest,
  McpElicitationResult,
  McpElicitationUrlRequest,
} from './types.js';

export interface McpClientRequestHandler {
  registerCapabilities?:
    | ((capabilities: {
        readonly elicitation: {
          readonly form?: Record<string, never> | undefined;
          readonly url?: Record<string, never> | undefined;
        };
      }) => void)
    | undefined;
  setRequestHandler?:
    | ((
        method: 'elicitation/create',
        handler: (request: {
          readonly params: McpElicitationRequest;
        }) => Promise<McpElicitationResult>,
      ) => void)
    | undefined;
}

export function registerElicitationHandlers(
  client: McpClientRequestHandler,
  handlers: McpElicitationHandlers | undefined,
): void {
  if (handlers === undefined) return;

  const supportsForm = handlers.form !== undefined;
  const supportsUrl = handlers.url !== undefined;
  if (!supportsForm && !supportsUrl) {
    throw new TypeError('At least one MCP elicitation handler must be provided');
  }
  if (client.registerCapabilities === undefined || client.setRequestHandler === undefined) {
    throw new TypeError(
      'The MCP client does not support elicitation capabilities and request handlers',
    );
  }

  client.registerCapabilities({
    elicitation: {
      ...(supportsForm ? { form: {} } : {}),
      ...(supportsUrl ? { url: {} } : {}),
    },
  });
  client.setRequestHandler('elicitation/create', async ({ params }) => {
    if (params.mode === 'url') {
      const request = params as McpElicitationUrlRequest;
      if (handlers.url === undefined) {
        throw new Error('MCP server requested URL elicitation, but no URL handler is configured');
      }
      return handlers.url(request);
    }

    const request = params as McpElicitationFormRequest;
    if (handlers.form === undefined) {
      throw new Error('MCP server requested form elicitation, but no form handler is configured');
    }
    return handlers.form(request);
  });
}
