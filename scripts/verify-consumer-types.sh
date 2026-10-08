#!/usr/bin/env bash
#
# Type-level consumer verification (audit TYP-03).
#
# `@arethetypeswrong/cli` (run in CI as `check:types`) statically verifies that
# every entry point resolves for node10 / node16-CJS / node16-ESM / bundler
# consumers. This script goes one step further and COMPILES two real consumer
# projects against the packed tarball:
#
#   1. a CommonJS consumer  (module node16)  -> resolves via the `require`
#      condition to the .d.cts declarations — the exact scenario of the
#      TS1479 "masquerading ESM types" failure class
#   2. an ESM consumer      (module nodenext) -> resolves via the `import`
#      condition to the .d.ts declarations
#
# Both consumers exercise the root entry plus a subpath export and the current
# public surface (chat, embed, embedBatch, destroy, generated Zod schemas).
# Any declaration drift that only manifests under strict consumer-side
# compilation (missing optional peer types, ESM-only syntax in .d.cts, etc.)
# fails here instead of in a downstream project.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
TSC="$REPO_ROOT/node_modules/.bin/tsc"
if [ ! -x "$TSC" ]; then
  echo "error: TypeScript compiler not found at $TSC (run npm ci first)" >&2
  exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

cd "$REPO_ROOT"
TARBALL=$(npm pack --pack-destination "$TMP" 2>/dev/null | tail -n 1)
echo "packed: $TARBALL"

# Identical source for both consumers — only the nearest package.json "type"
# differs, which is what selects the module kind under node16 resolution.
write_consumer_source() {
  cat > "$1/index.ts" <<'EOF'
import { OllamaClient, batchEmbed } from '@nemesis-oss/ollama-sdk';
import { ChatRequestSchema } from '@nemesis-oss/ollama-sdk/generated/models/schemas';

const corpus: readonly string[] = ['hello', 'world'];

export async function run(): Promise<number> {
  const client = new OllamaClient({ baseUrl: 'http://localhost:11434' });
  try {
    const chat = await client.chat({
      model: 'llama3',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const { embeddings } = await client.embedBatch({
      model: 'nomic-embed-text:latest',
      input: corpus,
      batchSize: 2,
      concurrency: 1,
    });
    // Standalone form, sharing the client's pipeline.
    const standalone = await batchEmbed(client, { model: 'nomic-embed-text:latest', input: [] });
    if (!ChatRequestSchema.safeParse({ model: 'm', messages: [] }).success) {
      throw new Error('schema import broken');
    }
    return chat.prompt_eval_count ?? 0 + embeddings.length + standalone.batchCount;
  } finally {
    client.destroy('consumer verification done');
  }
}
EOF
}

# --- CommonJS consumer: module node16 forces the `require` condition (.d.cts) ---
mkdir -p "$TMP/cjs"
cat > "$TMP/cjs/package.json" <<'EOF'
{ "name": "cjs-consumer", "version": "1.0.0", "private": true, "type": "commonjs" }
EOF
write_consumer_source "$TMP/cjs"
(
  cd "$TMP/cjs"
  npm install --no-fund --no-audit --loglevel=error "$TMP/$TARBALL" zod @opentelemetry/api
  "$TSC" --noEmit --strict --target es2022 --module node16 --moduleResolution node16 index.ts
)
echo "CJS (node16 -> .d.cts via require condition): OK"

# --- ESM consumer: module nodenext forces the `import` condition (.d.ts) ---
mkdir -p "$TMP/esm"
cat > "$TMP/esm/package.json" <<'EOF'
{ "name": "esm-consumer", "version": "1.0.0", "private": true, "type": "module" }
EOF
write_consumer_source "$TMP/esm"
(
  cd "$TMP/esm"
  npm install --no-fund --no-audit --loglevel=error "$TMP/$TARBALL" zod @opentelemetry/api
  "$TSC" --noEmit --strict --target es2022 --module nodenext --moduleResolution nodenext index.ts
)
echo "ESM (nodenext -> .d.ts via import condition): OK"

echo "consumer type verification passed"
