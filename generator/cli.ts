#!/usr/bin/env tsx
/**
 * Contract pipeline CLI.
 *
 * Subcommands:
 *   normalize   Compile sources + overlays → contracts/ir/ollama.ir.json
 *   validate    Run all validators (schema, compatibility, endpoint discovery)
 *   diff        Diff the current IR against the committed one
 *   info        Print a summary of the current contract
 *
 * Wave 1 scope: foundation only. Later waves add `generate` (TypeScript
 * types from the IR) and `mcp` (MCP tool definitions from the IR).
 */
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

import { normalizeContract } from './normalize/contract-normalizer.js';
import { validateOverlay } from './validators/schema-validator.js';
import { validateCompatibility } from './validators/compatibility-validator.js';
import {
  validateEndpointDiscovery,
  assertNoDiscoveryDrift,
} from './validators/endpoint-validator.js';
import { readOverlaysForValidation } from './normalize/overlay-loader.js';
import { emitModels } from './emitters/typescript/models.js';
import { emitApi } from './emitters/typescript/api.js';
import { emitOperations, emitOperationsIndex } from './emitters/typescript/operations.js';
import { emitMetadata } from './emitters/metadata/metadata.js';
import { emitMcpTools } from './emitters/mcp/tools.js';
import { detectTypeDrift, formatDriftReport } from './emitters/typescript/drift-detector.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');

function cmdNormalize(): void {
  const contract = normalizeContract(PROJECT_ROOT, { write: true });
  console.log(
    `✓ IR written to contracts/ir/ollama.ir.json ` +
      `(${contract.operations.length} operations, ${contract.schemas.length} schemas, hash ${contract.sourceHash})`,
  );
}

function cmdValidate(): void {
  const contract = normalizeContract(PROJECT_ROOT, { write: false });

  // 1. Overlay schema validation.
  const overlayFiles = readOverlaysForValidation(PROJECT_ROOT);
  let overlayErrors = 0;
  for (const { file, domain } of overlayFiles) {
    const result = validateOverlay(file, domain);
    if (result.errors.length > 0) {
      overlayErrors += result.errors.length;
      console.error(`✗ ${file}`);
      for (const err of result.errors) console.error(`    ${err}`);
    } else {
      console.log(`✓ ${file} overlay schema valid`);
    }
  }

  // 2. Cross-overlay compatibility.
  const compat = validateCompatibility(contract.operations);
  if (compat.errors.length > 0) {
    overlayErrors += compat.errors.length;
    console.error('✗ Cross-overlay compatibility:');
    for (const err of compat.errors) console.error(`    ${err}`);
  } else {
    console.log('✓ Cross-overlay compatibility valid');
  }

  // 3. Bidirectional endpoint discovery — the new gate the legacy
  //    verifier was missing.
  const discovery = validateEndpointDiscovery(PROJECT_ROOT, contract.operations);
  try {
    assertNoDiscoveryDrift(discovery);
    console.log(
      `✓ Bidirectional endpoint discovery: ` +
        `${discovery.declared.length} declared, ${discovery.discovered.length} discovered, no drift`,
    );
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
    return;
  }

  if (overlayErrors > 0) {
    process.exitCode = 1;
    return;
  }

  console.log(
    `\nContract validation passed: ${contract.operations.length} operations across all overlays.`,
  );
}

function cmdDiff(): void {
  const fresh = normalizeContract(PROJECT_ROOT, { write: false });
  let committedRaw: string;
  try {
    committedRaw = readFileSync(resolve(PROJECT_ROOT, 'contracts/ir/ollama.ir.json'), 'utf8');
  } catch {
    console.error(
      'No committed IR found at contracts/ir/ollama.ir.json. Run `contract:normalize` first.',
    );
    process.exitCode = 1;
    return;
  }
  const committed = JSON.parse(committedRaw) as typeof fresh;

  const freshOps = new Map(fresh.operations.map((op) => [op.id, op]));
  const committedOps = new Map(committed.operations.map((op) => [op.id, op]));

  const added = [...freshOps.keys()].filter((id) => !committedOps.has(id));
  const removed = [...committedOps.keys()].filter((id) => !freshOps.has(id));

  if (added.length === 0 && removed.length === 0 && fresh.sourceHash === committed.sourceHash) {
    console.log('✓ No contract drift. IR is up to date.');
    return;
  }

  if (added.length > 0) {
    console.log('Added operations:');
    for (const id of added) console.log(`  + ${id}`);
  }
  if (removed.length > 0) {
    console.log('Removed operations:');
    for (const id of removed) console.log(`  - ${id}`);
  }
  console.log(
    `\nRun \`npm run contract:normalize\` to refresh contracts/ir/ollama.ir.json, ` +
      `then commit the result.`,
  );
  process.exitCode = 1;
}

function cmdGenerate(): void {
  const contract = normalizeContract(PROJECT_ROOT, { write: false });
  const writtenFiles: string[] = [];

  const modelFiles = emitModels('src/generated/models', contract.schemas);
  const apiFiles = emitApi('src/generated/api', contract.operations);
  const opsFiles = [
    emitOperations('src/generated/api', contract.operations),
    emitOperationsIndex('src/generated/api', contract.operations),
  ];
  const metadataFile = emitMetadata('src/generated/metadata', contract.operations);
  const mcpToolsFile = emitMcpTools('src/generated/mcp', contract.operations, contract.schemas);

  const allFiles = [...modelFiles, ...apiFiles, ...opsFiles, metadataFile, mcpToolsFile];
  for (const file of allFiles) {
    const absolute = resolve(PROJECT_ROOT, file.path);
    mkdirSync(resolve(absolute, '..'), { recursive: true });
    writeFileSync(absolute, file.content, 'utf8');
    writtenFiles.push(file.path);
  }

  console.log(`✓ Generated ${writtenFiles.length} files:`);
  for (const p of writtenFiles) console.log(`  - ${p}`);

  // Drift report — informational, not a gate. Surfacing drift early is the
  // whole point of Wave 2; making it a CI gate would be premature until
  // the migration is complete (Wave 3+).
  const drift = detectTypeDrift(PROJECT_ROOT, contract.schemas);
  console.log('\n' + formatDriftReport(drift));
}

function cmdDrift(): void {
  const contract = normalizeContract(PROJECT_ROOT, { write: false });
  const drift = detectTypeDrift(PROJECT_ROOT, contract.schemas);
  console.log(formatDriftReport(drift));
  // Exit non-zero only when there's drift AND the user passed --strict.
  if (process.argv.includes('--strict') && (drift.totalAdded > 0 || drift.totalRemoved > 0)) {
    process.exitCode = 1;
  }
}

function cmdInfo(): void {
  const contract = normalizeContract(PROJECT_ROOT, { write: false });
  const byDomain = contract.operations.reduce<Record<string, number>>((acc, op) => {
    acc[op.domain] = (acc[op.domain] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`Ollama contract IR v${contract.contractVersion}`);
  if (contract.observedOllamaVersion) {
    console.log(`  observed ollama version: ${contract.observedOllamaVersion}`);
  }
  console.log(`  source hash: ${contract.sourceHash}`);
  console.log(`  generated at: ${contract.generatedAt}`);
  console.log(`  operations (${contract.operations.length}):`);
  for (const [domain, count] of Object.entries(byDomain)) {
    console.log(`    ${domain}: ${count}`);
  }
  console.log(`  schemas: ${contract.schemas.length}`);
  console.log(`  parity-bridge entries: ${contract.parityBridge.length}`);
}

const command = process.argv[2] ?? 'info';
switch (command) {
  case 'normalize':
    cmdNormalize();
    break;
  case 'validate':
    cmdValidate();
    break;
  case 'diff':
    cmdDiff();
    break;
  case 'generate':
    cmdGenerate();
    break;
  case 'drift':
    cmdDrift();
    break;
  case 'info':
    cmdInfo();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    console.error('Usage: tsx generator/cli.ts [normalize|validate|diff|generate|drift|info]');
    process.exitCode = 2;
}
