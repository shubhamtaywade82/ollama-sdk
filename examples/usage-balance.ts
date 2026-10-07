/**
 * Ollama Cloud usage & balance (see src/client.ts — cloud account endpoints).
 *
 * Wraps the hosted account endpoints at https://ollama.com:
 *   GET /api/usage   — request counts, USD spend, token totals (hour/day buckets)
 *   GET /api/balance — remaining included + purchased credits
 *
 * Requires an Ollama account API key (`apiKey` on the client, or the
 * OLLAMA_API_KEY environment variable), independent of any local baseUrl.
 *
 *   OLLAMA_API_KEY=... npm run example examples/usage-balance.ts
 */
import { OllamaClient } from '../src/index.js';

async function main() {
  const client = new OllamaClient({
    baseUrl: 'http://localhost:11434', // local inference — unrelated to the calls below
    apiKey: process.env.OLLAMA_API_KEY,
  });

  // 1. Usage for the last 24 hours, bucketed hourly. Omit options entirely
  //    for the server defaults (range='7d', scope='self'); 'team' scope
  //    requires a team admin.
  const usage = await client.usage({ range: '24h' });
  const totals = usage.totals;
  console.log(
    `usage[${usage.range}/${usage.scope}] requests=${totals.request_count}` +
      ` usd=${totals.usage_usd ?? 'n/a'}` +
      ` in=${totals.input_tokens ?? 'n/a'} (cached ${totals.cached_input_tokens ?? 'n/a'})` +
      ` out=${totals.output_tokens ?? 'n/a'}`,
  );
  for (const bucket of usage.buckets) {
    if (bucket.request_count === 0) continue; // quiet hours/days are included as zeroes
    const tag = bucket.partial === true ? ' (partial — still in progress)' : '';
    console.log(`  ${bucket.from} -> ${bucket.until}: ${bucket.request_count} requests${tag}`);
  }

  // 2. Remaining credits. The included balance is either the plan-period
  //    credits object or, on legacy plans, session/weekly percentage limits.
  const balance = await client.balance();
  if ('balance_usd' in balance.included) {
    const period = balance.included.period;
    console.log(
      `included: $${balance.included.balance_usd} of $${balance.included.allowance_usd}` +
        ` (resets ${period.until})`,
    );
  } else {
    console.log(
      `included (legacy plan): session ${balance.included.session.remaining_percent}% left` +
        ` (resets ${balance.included.session.resets_at}),` +
        ` weekly ${balance.included.weekly.remaining_percent}% left` +
        ` (resets ${balance.included.weekly.resets_at})`,
    );
  }
  console.log(`purchased: $${balance.purchased.balance_usd}`);

  // 3. Team-wide usage (team admins only).
  if (process.argv[2] === '--team') {
    const teamUsage = await client.usage({ range: '7d', scope: 'team' });
    console.log(`team 7d usage: ${teamUsage.totals.request_count} requests`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
