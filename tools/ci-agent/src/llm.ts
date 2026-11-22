import {
  OllamaClient,
  parseStructuredOutput,
  zodToJsonSchema,
  type SupportedSchema,
} from '@nemesis-oss/ollama-sdk';
import { z } from 'zod';

export interface StructuredLlmOptions<T> {
  model: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export async function callStructuredLlm<T>(options: StructuredLlmOptions<T>): Promise<T> {
  const client = new OllamaClient({
    baseUrl: options.baseUrl ?? process.env.OLLAMA_HOST ?? 'https://ollama.com',
    apiKey: options.apiKey ?? process.env.OLLAMA_API_KEY,
    fetch: options.fetch,
    timeoutMs: 60_000,
  });

  // Prompt-enforced JSON schema is used because Ollama Cloud rejects wire format parameter
  const schema = options.schema as unknown as SupportedSchema<T>;
  const schemaJson = JSON.stringify(zodToJsonSchema(schema), null, 2);
  const systemWithSchema = `${options.system}
CRITICAL: Output ONLY valid JSON matching this JSON Schema:
${schemaJson}
Do not include any explanation, conversational text, or commentary outside the JSON block.`;

  const response = await client.chat({
    model: options.model,
    stream: false,
    options: { temperature: 0, seed: 42 },
    messages: [
      { role: 'system', content: systemWithSchema },
      { role: 'user', content: options.prompt },
    ],
  });

  return parseStructuredOutput(response.message.content, schema);
}
