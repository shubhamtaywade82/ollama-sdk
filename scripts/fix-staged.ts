import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { extname, resolve } from 'node:path';

const staged = execFileSync(
  'git',
  ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'],
  { encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean)
  .filter((file) => !file.startsWith('../') && !file.startsWith('/'))
  .filter((file) => existsSync(resolve(file)));

if (staged.length === 0) {
  console.log('No staged files to auto-fix.');
  process.exit(0);
}

const prettierFiles = staged.filter((file) => {
  const extension = extname(file).toLowerCase();
  return !['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.lock'].includes(extension);
});
const eslintFiles = staged.filter((file) =>
  ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'].includes(
    extname(file).toLowerCase(),
  ),
);

function run(command: string, args: string[]): void {
  if (args.length === 0) return;
  execFileSync(command, args, { stdio: 'inherit' });
}

run('npx', ['prettier', '--write', ...prettierFiles]);
run('npx', ['eslint', '--fix', ...eslintFiles]);

// Re-stage only the files that were already staged. Unstaged work in other
// files is never added to the commit.
run('git', ['add', '--', ...staged]);
console.log(`Auto-fixed and re-staged ${staged.length} staged file(s).`);
