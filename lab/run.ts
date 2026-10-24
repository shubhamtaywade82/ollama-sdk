import { readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function discoverExperiments(dir = __dirname): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter(
      (e) =>
        e.isFile() &&
        e.name.endsWith('.ts') &&
        e.name !== 'run.ts' &&
        !e.parentPath.includes('support'),
    )
    .map((e) => relative(__dirname, join(e.parentPath, e.name)))
    .sort();
}

function printHelp(experiments: readonly string[]): void {
  console.log('🧪 Ollama SDK Manual Laboratory Runner\n');
  console.log('Usage:');
  console.log('  npx tsx lab/run.ts <experiment-path-or-keyword>');
  console.log('  npx tsx lab/run.ts list\n');
  console.log('Available Experiments:');
  experiments.forEach((exp, idx) => {
    console.log(`  [${String(idx + 1).padStart(2, ' ')}] ${exp}`);
  });
  console.log('\nRun an individual experiment directly:');
  console.log('  npx tsx lab/00-smoke/local-chat.ts');
}

async function main(): Promise<void> {
  const experiments = await discoverExperiments();
  const target = process.argv[2];

  if (!target || target === 'list' || target === '--help') {
    printHelp(experiments);
    return;
  }

  const num = parseInt(target, 10);
  const matched = !isNaN(num)
    ? experiments[num - 1]
    : experiments.find((exp) => exp.includes(target));

  if (!matched) {
    console.error(`❌ No experiment matched query: "${target}"`);
    console.log('Run `npx tsx lab/run.ts list` to see all available experiments.');
    process.exit(1);
  }

  const fullPath = join(__dirname, matched);
  console.log(`🚀 Running experiment: ${matched} ...\n`);
  await import(pathToFileURL(fullPath).href);
}

void main();
