import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../src/tools/define-tool.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { Agent } from '../src/agent/agent.js';
import { toResponse, toTextStream } from '../src/streaming/adapters.js';
import { useVcr } from './vcr.js';

describe('Agentic Workflow and Feature Integrations', () => {
  const MODEL_NAME = 'qwen3.5:2b';

  it('orchestrates autonomous multi-turn tool calling workflow', async () => {
    await useVcr('agent_multiturn_tool_workflow', async (client) => {
      const getBalanceTool = defineTool({
        name: 'get_balance',
        description: 'Get user bank account balance by ID',
        schema: z.object({
          accountId: z.string().describe('The account identifier'),
        }),
        execute: ({ accountId }) => {
          return { accountId, balance: 1250.0, currency: 'USD' };
        },
      });

      const registry = new ToolRegistry([getBalanceTool]);
      const toolEvents: string[] = [];

      const agent = new Agent(client, {
        tools: registry,
        maxIterations: 5,
        validateToolCapability: false,
        hooks: {
          onToolCallStart: (tc) => {
            toolEvents.push(`start:${tc.function.name}`);
          },
          onToolCallEnd: (res) => {
            toolEvents.push(`end:${res.toolName}:${res.success}`);
          },
        },
      });

      const result = await agent.run({
        model: MODEL_NAME,
        messages: [
          {
            role: 'system',
            content: 'You are a banking assistant. Use available tools to check balances.',
          },
          {
            role: 'user',
            content: 'What is the balance of account acc_400? Use get_balance tool.',
          },
        ],
        options: { temperature: 0 },
      });

      expect(toolEvents).toContain('start:get_balance');
      expect(toolEvents).toContain('end:get_balance:true');
      expect(result.finalMessage.content).toMatch(/1250|1,250/);
      expect(result.turns.length).toBeGreaterThanOrEqual(2);
    });
  }, 120_000);

  it('recovers from failed tool executions and communicates error to user', async () => {
    await useVcr('agent_tool_error_recovery', async (client) => {
      const inventoryTool = defineTool({
        name: 'check_inventory',
        description: 'Checks stock inventory database',
        schema: z.object({ sku: z.string() }),
        execute: () => {
          throw new Error('Database connection timed out');
        },
      });

      const registry = new ToolRegistry([inventoryTool]);
      const agent = new Agent(client, {
        tools: registry,
        maxIterations: 3,
        validateToolCapability: false,
      });

      const result = await agent.run({
        model: MODEL_NAME,
        messages: [
          { role: 'user', content: 'Check inventory for SKU ITEM_99 using check_inventory tool.' },
        ],
        options: { temperature: 0 },
      });

      expect(result.turns.length).toBeGreaterThanOrEqual(1);
      expect(result.finalMessage.content.length).toBeGreaterThan(0);
    });
  }, 120_000);

  it('converts streaming model output to Web standard streams and HTTP Response', async () => {
    await useVcr('streaming_web_standards_response', async (client) => {
      const stream = await client.chatStream({
        model: MODEL_NAME,
        messages: [{ role: 'user', content: 'Say "Stream OK"' }],
        options: { temperature: 0 },
      });

      const textStream = toTextStream(stream);
      const reader = textStream.getReader();
      const collected: string[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        collected.push(value);
      }

      expect(collected.join('')).toContain('Stream OK');

      const responseStream = await client.chatStream({
        model: MODEL_NAME,
        messages: [{ role: 'user', content: 'Say "Response OK"' }],
        options: { temperature: 0 },
      });

      const httpResponse = toResponse(responseStream);
      expect(httpResponse.status).toBe(200);
      expect(httpResponse.headers.get('Content-Type')).toContain('text/plain');
      const responseText = await httpResponse.text();
      expect(responseText).toContain('Response OK');
    });
  }, 120_000);
});
