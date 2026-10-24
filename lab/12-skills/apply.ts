import { applySkill, OllamaClient, type Skill } from '../../src/index.js';
import { getLabEnv } from '../support/env.js';
import { labLogger } from '../support/logger.js';

const conciseSummarizerSkill: Skill = {
  name: 'one-bullet-summarizer',
  description: 'Summarizes any text in exactly one single bullet point starting with •',
  body: 'You are an ultra-concise summarizer. Output strictly one bullet point starting with "• ". Do not output any greetings or extras.',
  path: 'skills/one-bullet-summarizer/SKILL.md',
  frontmatter: {
    name: 'one-bullet-summarizer',
    description: 'Summarizes any text in exactly one single bullet point starting with •',
  },
};

async function main(): Promise<void> {
  const env = getLabEnv();
  const client = new OllamaClient({ baseUrl: env.localBaseUrl });
  const start = Date.now();

  const userMessages = [
    {
      role: 'user' as const,
      content:
        'Docker containerization packages applications and OS libraries together to guarantee deterministic runtime behavior across cloud and local servers.',
    },
  ];

  const applied = applySkill(conciseSummarizerSkill, { messages: userMessages });

  try {
    const res = await client.chat({
      model: env.localModel,
      messages: applied.messages,
    });

    await labLogger.log({
      experimentId: '12-skills-apply',
      timestamp: new Date().toISOString(),
      provider: 'local',
      endpoint: env.localBaseUrl,
      model: env.localModel,
      operation: 'applySkill & chat',
      durationMs: Date.now() - start,
      response: {
        synthesizedPrompt: applied.messages[0]?.content,
        modelOutput: res.message.content,
      },
    });
  } catch (err) {
    await labLogger.log({
      experimentId: '12-skills-apply',
      timestamp: new Date().toISOString(),
      provider: 'local',
      endpoint: env.localBaseUrl,
      model: env.localModel,
      operation: 'applySkill & chat',
      durationMs: Date.now() - start,
      error: (err as Error).message,
    });
  }
}

void main();
