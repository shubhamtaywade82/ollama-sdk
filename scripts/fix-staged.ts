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

// Avoid staging unrelated working-tree hunks when formatting a partially
// staged file. Require the developer to stage or stash those edits first.
const unstagedInStagedFiles = execFileSync('git', ['diff', '--name-only', '--', ...staged], {
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);

if (unstagedInStagedFiles.length > 0) {
  throw new Error(
    [
      'Refusing to auto-fix partially staged files:',
      ...unstagedInStagedFiles.map((file) => '  - ' + file),
      'Stage or stash the remaining edits in those files, then retry the commit.',
    ].join('\n'),
  );
}

const prettierExtensions = new Set([
  '.astro',
  '.css',
  '.graphql',
  '.gql',
  '.html',
  '.js',
  '.jsx',
  '.json',
  '.jsonc',
  '.md',
  '.mdx',
  '.mjs',
  '.mts',
  '.scss',
  '.ts',
  '.tsx',
  '.vue',
  '.yaml',
  '.yml',
]);
const eslintExtensions = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);

const prettierFiles = staged
  .filter((file) => prettierExtensions.has(extname(file).toLowerCase()))
  .map((file) => './' + file);
const eslintFiles = staged
  .filter((file) => eslintExtensions.has(extname(file).toLowerCase()))
  .map((file) => './' + file);

function run(args: string[]): void {
  if (args.length === 0) return;
  execFileSync(process.execPath, args, { stdio: 'inherit' });
}

const prettierCli = resolve('node_modules/prettier/bin/prettier.cjs');
const eslintCli = resolve('node_modules/eslint/bin/eslint.js');

if (prettierFiles.length > 0 && !existsSync(prettierCli)) {
  throw new Error('Prettier is not installed. Run npm ci before committing.');
}
if (eslintFiles.length > 0 && !existsSync(eslintCli)) {
  throw new Error('ESLint is not installed. Run npm ci before committing.');
}

run(prettierFiles.length > 0 ? [prettierCli, '--write', ...prettierFiles] : []);
run(eslintFiles.length > 0 ? [eslintCli, '--fix', ...eslintFiles] : []);

// Re-stage only the paths that were already staged. No unrelated file is added.
execFileSync('git', ['add', '--', ...staged], { stdio: 'inherit' });
console.log('Auto-fixed and re-staged ' + staged.length + ' staged file(s).');
