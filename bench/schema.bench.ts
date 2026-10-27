import { test } from 'vitest';
import { z } from 'zod';
import { parseStructuredOutput, zodToJsonSchema } from '../src/schema/zod.js';

const SimpleSchema = z.object({
  name: z.string(),
  age: z.number(),
});

const NestedSchema = z.object({
  id: z.string(),
  title: z.string(),
  price: z.number(),
  tags: z.array(z.string()),
  category: z.enum(['electronics', 'books', 'apparel', 'home', 'toys']),
  metadata: z.object({
    createdAt: z.string(),
    updatedAt: z.string(),
    author: z.object({
      name: z.string(),
      email: z.string(),
    }),
  }),
  variants: z.array(
    z.object({
      sku: z.string(),
      inStock: z.boolean(),
      quantity: z.number(),
    }),
  ),
});

const nestedPayload = JSON.stringify({
  id: 'p-1',
  title: 'Gaming Keyboard',
  price: 129.99,
  tags: ['mechanical', 'rgb'],
  category: 'electronics',
  metadata: {
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    author: { name: 'Alice', email: 'alice@example.com' },
  },
  variants: [
    { sku: 'kb-black', inStock: true, quantity: 12 },
    { sku: 'kb-white', inStock: false, quantity: 0 },
  ],
});

const markdownFencedPayload = '```json\n' + nestedPayload + '\n```';

test('zodToJsonSchema', async ({ bench }) => {
  bench('simple object (2 fields)', () => {
    zodToJsonSchema(SimpleSchema);
  });

  bench('nested object (arrays, enums, nested objects)', () => {
    zodToJsonSchema(NestedSchema);
  });
});

test('parseStructuredOutput', async ({ bench }) => {
  bench('raw JSON', () => {
    parseStructuredOutput(nestedPayload, NestedSchema);
  });

  bench('markdown-fenced JSON', () => {
    parseStructuredOutput(markdownFencedPayload, NestedSchema);
  });
});
