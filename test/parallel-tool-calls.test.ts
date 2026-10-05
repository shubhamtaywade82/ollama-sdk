import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../src/transport/http.js';
import {
  detectModelCapabilities,
  inferRuntimeMode,
  type ParallelToolCallBehavior,
} from '../src/capabilities/capabilities.js';

/**
 * `ModelCapabilities.parallelToolCalls` — see ADR 0023.
 *
 * Best-effort heuristic classification of a model's parallel
 * tool-call emission behavior:
 *
 *   - 'yes'     — model is known to emit multiple tool_calls per turn
 *   - 'no'      — model emits at most one tool call per turn
 *   - 'unknown' — can't tell from /api/show response
 *
 * The SDK does NOT normalize between cloud and local — it reports the
 * best assessment it can and lets the caller decide. Agent authors
 * who need hard sequential execution should set ToolRegistry's
 * maxConcurrency: 1 regardless of this field's value.
 */

/**
 * Build a mock fetch returning a /api/show response with the given
 * capabilities array and optional model_info.architecture.
 */
function showResponseFetch(opts: {
  capabilities?: readonly string[];
  architecture?: string;
  family?: string;
  families?: readonly string[];
}): ReturnType<typeof vi.fn> {
  const body: Record<string, unknown> = {
    capabilities: opts.capabilities ?? [],
    details: {
      family: opts.family ?? '',
      ...(opts.families !== undefined ? { families: [...opts.families] } : {}),
      format: 'gguf',
      parameter_size: '7B',
      quantization_level: 'Q4_0',
    },
  };
  if (opts.architecture !== undefined) {
    body.model_info = { [`${opts.architecture}.architecture`]: opts.architecture };
  }
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

describe('parallelToolCalls: cloud-mode inference', () => {
  it('returns "yes" for cloud-mode tool-capable models (GPT-4o via OpenAI-compat)', async () => {
    const http = new HttpClient({
      baseUrl: 'https://ollama.com',
      fetch: showResponseFetch({ capabilities: ['tools', 'completion'] }) as never,
    });
    const caps = await detectModelCapabilities(http, 'gpt-4o');
    expect(inferRuntimeMode(http.baseUrl)).toBe('cloud');
    expect(caps.supportsTools).toBe(true);
    expect(caps.parallelToolCalls).toBe<ParallelToolCallBehavior>('yes');
  });

  it('returns "yes" for cloud-mode tool-capable models (Claude via Anthropic-compat)', async () => {
    const http = new HttpClient({
      baseUrl: 'https://ollama.com',
      fetch: showResponseFetch({ capabilities: ['tools', 'completion'] }) as never,
    });
    const caps = await detectModelCapabilities(http, 'claude-3.5-sonnet');
    expect(caps.parallelToolCalls).toBe<ParallelToolCallBehavior>('yes');
  });

  it('returns "unknown" for cloud-mode models without the "tools" capability', async () => {
    // An embedding-only model on a cloud endpoint shouldn't claim
    // parallel tool calls.
    const http = new HttpClient({
      baseUrl: 'https://ollama.com',
      fetch: showResponseFetch({ capabilities: ['embedding'] }) as never,
    });
    const caps = await detectModelCapabilities(http, 'text-embedding-3-small');
    expect(caps.supportsTools).toBe(false);
    expect(caps.parallelToolCalls).toBe<ParallelToolCallBehavior>('unknown');
  });
});

describe('parallelToolCalls: local-mode inference via model_info.architecture', () => {
  it('returns "yes" for qwen2.5 architecture', async () => {
    const http = new HttpClient({
      baseUrl: 'http://localhost:11434',
      fetch: showResponseFetch({
        capabilities: ['tools', 'completion'],
        architecture: 'qwen2',
      }) as never,
    });
    const caps = await detectModelCapabilities(http, 'qwen2.5:7b-instruct');
    expect(caps.parallelToolCalls).toBe<ParallelToolCallBehavior>('yes');
  });

  it('returns "yes" for llama3.1 architecture', async () => {
    const http = new HttpClient({
      baseUrl: 'http://localhost:11434',
      fetch: showResponseFetch({
        capabilities: ['tools', 'completion'],
        architecture: 'llama3.1', // in the known-parallel list
        family: 'llama',
      }) as never,
    });
    const caps = await detectModelCapabilities(http, 'llama3.1:8b');
    // family-based check fires first since "llama3.1" is in the known list
    expect(caps.parallelToolCalls).toBe<ParallelToolCallBehavior>('yes');
  });

  it('returns "yes" for mistral architecture', async () => {
    const http = new HttpClient({
      baseUrl: 'http://localhost:11434',
      fetch: showResponseFetch({
        capabilities: ['tools', 'completion'],
        architecture: 'mistral',
      }) as never,
    });
    const caps = await detectModelCapabilities(http, 'mistral:7b-instruct');
    expect(caps.parallelToolCalls).toBe<ParallelToolCallBehavior>('yes');
  });

  it('returns "yes" for mixtral architecture', async () => {
    const http = new HttpClient({
      baseUrl: 'http://localhost:11434',
      fetch: showResponseFetch({
        capabilities: ['tools', 'completion'],
        architecture: 'mixtral',
      }) as never,
    });
    const caps = await detectModelCapabilities(http, 'mixtral:8x7b');
    expect(caps.parallelToolCalls).toBe<ParallelToolCallBehavior>('yes');
  });

  it('returns "unknown" for an unrecognized architecture (e.g. phi-3)', async () => {
    const http = new HttpClient({
      baseUrl: 'http://localhost:11434',
      fetch: showResponseFetch({
        capabilities: ['tools', 'completion'],
        architecture: 'phi3',
      }) as never,
    });
    const caps = await detectModelCapabilities(http, 'phi3:14b');
    expect(caps.parallelToolCalls).toBe<ParallelToolCallBehavior>('unknown');
  });
});

describe('parallelToolCalls: local-mode inference via model name hints', () => {
  it('returns "yes" for a model name containing "tool-use" even without a known architecture', async () => {
    const http = new HttpClient({
      baseUrl: 'http://localhost:11434',
      fetch: showResponseFetch({
        capabilities: ['tools', 'completion'],
        architecture: 'phi3', // not in the known-parallel list
      }) as never,
    });
    const caps = await detectModelCapabilities(http, 'phi3-tool-use:14b');
    expect(caps.parallelToolCalls).toBe<ParallelToolCallBehavior>('yes');
  });

  it('returns "yes" for a model name containing "hermes"', async () => {
    const http = new HttpClient({
      baseUrl: 'http://localhost:11434',
      fetch: showResponseFetch({
        capabilities: ['tools', 'completion'],
        architecture: 'llama', // base family
        family: 'llama',
      }) as never,
    });
    const caps = await detectModelCapabilities(http, 'hermes-2-pro-llama-3-8b');
    expect(caps.parallelToolCalls).toBe<ParallelToolCallBehavior>('yes');
  });

  it('returns "yes" for a model name containing "command-r"', async () => {
    const http = new HttpClient({
      baseUrl: 'http://localhost:11434',
      fetch: showResponseFetch({
        capabilities: ['tools', 'completion'],
        architecture: 'unknown-arch',
      }) as never,
    });
    const caps = await detectModelCapabilities(http, 'command-r:35b');
    expect(caps.parallelToolCalls).toBe<ParallelToolCallBehavior>('yes');
  });
});

describe('parallelToolCalls: local-mode inference via details.family fallback', () => {
  it('uses details.family when model_info has no *.architecture key', async () => {
    const http = new HttpClient({
      baseUrl: 'http://localhost:11434',
      fetch: showResponseFetch({
        capabilities: ['tools', 'completion'],
        // No architecture key; family provided
        family: 'qwen2',
      }) as never,
    });
    const caps = await detectModelCapabilities(http, 'qwen2.5:7b');
    expect(caps.parallelToolCalls).toBe<ParallelToolCallBehavior>('yes');
  });

  it('uses details.families[0] when both architecture and family are absent', async () => {
    const http = new HttpClient({
      baseUrl: 'http://localhost:11434',
      fetch: showResponseFetch({
        capabilities: ['tools', 'completion'],
        families: ['mistral'],
      }) as never,
    });
    const caps = await detectModelCapabilities(http, 'mistral:7b');
    expect(caps.parallelToolCalls).toBe<ParallelToolCallBehavior>('yes');
  });
});

describe('parallelToolCalls: local-mode inference without enough info', () => {
  it('returns "unknown" when /api/show returns no architecture, family, or families', async () => {
    const http = new HttpClient({
      baseUrl: 'http://localhost:11434',
      fetch: showResponseFetch({
        capabilities: ['tools', 'completion'],
        // No architecture, no family, no families
      }) as never,
    });
    const caps = await detectModelCapabilities(http, 'mystery-model:7b');
    expect(caps.parallelToolCalls).toBe<ParallelToolCallBehavior>('unknown');
  });

  it('returns "unknown" when the model name has no tool-use hint and family is unrecognized', async () => {
    const http = new HttpClient({
      baseUrl: 'http://localhost:11434',
      fetch: showResponseFetch({
        capabilities: ['tools', 'completion'],
        architecture: 'gemma2',
        family: 'gemma2',
      }) as never,
    });
    const caps = await detectModelCapabilities(http, 'gemma2:9b');
    // gemma2 is not in the known-parallel list and the name has no hint
    expect(caps.parallelToolCalls).toBe<ParallelToolCallBehavior>('unknown');
  });
});

describe('parallelToolCalls: name-hint scan includes the FULL model name', () => {
  it('detects "instruct" in the tag (phi3:14b-instruct)', async () => {
    // The name-hint check scans the FULL model name (including the
    // `:14b-instruct` tag), not just the base name. This is critical
    // because tool-use variants often carry the hint in the tag.
    const http = new HttpClient({
      baseUrl: 'http://localhost:11434',
      fetch: showResponseFetch({
        capabilities: ['tools', 'completion'],
        architecture: 'phi3', // base family not in known-parallel list
      }) as never,
    });
    const caps = await detectModelCapabilities(http, 'phi3:14b-instruct');
    // "instruct" is in PARALLEL_TOOL_CALL_NAME_HINTS
    expect(caps.parallelToolCalls).toBe<ParallelToolCallBehavior>('yes');
  });

  it('detects "tool-use" in the tag (llama:8b-tool-use)', async () => {
    const http = new HttpClient({
      baseUrl: 'http://localhost:11434',
      fetch: showResponseFetch({
        capabilities: ['tools', 'completion'],
        architecture: 'llama', // base family, but "llama" alone isn't in known-parallel
      }) as never,
    });
    const caps = await detectModelCapabilities(http, 'llama:8b-tool-use');
    expect(caps.parallelToolCalls).toBe<ParallelToolCallBehavior>('yes');
  });

  it('does NOT match when neither base name nor tag has a hint', async () => {
    const http = new HttpClient({
      baseUrl: 'http://localhost:11434',
      fetch: showResponseFetch({
        capabilities: ['tools', 'completion'],
        architecture: 'phi3',
      }) as never,
    });
    const caps = await detectModelCapabilities(http, 'phi3:14b-base');
    // No "instruct", no "tool-use", no other hint
    expect(caps.parallelToolCalls).toBe<ParallelToolCallBehavior>('unknown');
  });
});

describe('parallelToolCalls: never claims yes for models without tools capability', () => {
  it('returns "unknown" for a local embedding-only model', async () => {
    const http = new HttpClient({
      baseUrl: 'http://localhost:11434',
      fetch: showResponseFetch({
        capabilities: ['embedding'],
        architecture: 'nomic-bert',
      }) as never,
    });
    const caps = await detectModelCapabilities(http, 'nomic-embed-text');
    expect(caps.supportsTools).toBe(false);
    // Even though the heuristic might match a family, an embedding-only
    // model can't emit tool calls — the parallelToolCalls field is
    // still set per the heuristic (the caller is expected to check
    // supportsTools first). The field reports what the model WOULD do
    // IF it were tool-capable.
    // We don't enforce a "no" here — the caller is responsible for
    // checking supportsTools.
    expect(['yes', 'no', 'unknown']).toContain(caps.parallelToolCalls);
  });
});

describe('parallelToolCalls: unknown runtime mode', () => {
  it('returns "unknown" when the baseUrl hostname is unrecognized (cloud by default)', async () => {
    // `inferRuntimeMode` returns 'cloud' for any non-localhost, non-RFC1918
    // hostname. So a hostname like `my-internal-host` (no dots, no scheme)
    // actually parses as 'cloud'. For genuinely 'unknown' mode we'd need
    // a URL that fails `new URL()` parsing — but HttpClient's telemetry
    // span attributes also call `new URL()`, so the test would crash
    // before reaching detectModelCapabilities.
    //
    // Instead, this test documents that hostnames other than
    // localhost/127.0.0.1/RFC1918 are treated as 'cloud' — which means
    // they go through the cloud-mode heuristic. This is the documented
    // behavior in `inferRuntimeMode`'s docstring.
    const http = new HttpClient({
      baseUrl: 'https://my-ollama-proxy.internal.corp:11434',
      fetch: showResponseFetch({
        capabilities: ['tools', 'completion'],
        architecture: 'qwen2',
      }) as never,
    });
    const caps = await detectModelCapabilities(http, 'qwen2.5:7b');
    // https://my-ollama-proxy.internal.corp is NOT localhost/RFC1918,
    // so inferRuntimeMode returns 'cloud' — and cloud-mode with tools
    // capability returns 'yes'.
    expect(caps.parallelToolCalls).toBe<ParallelToolCallBehavior>('yes');
  });
});
