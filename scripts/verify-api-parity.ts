/**
 * Verifies that the compatibility TypeScript interfaces still cover the
 * request surface documented by Ollama.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

interface SurfaceContract {
  readonly docsUrl: string;
  readonly sourceFile?: string;
  readonly interfaceName?: string;
  readonly endpoint: string;
  readonly fields: readonly string[];
}

const ROOT = resolve(import.meta.dirname, '..');

const CONTRACTS: readonly SurfaceContract[] = [
  { docsUrl: 'https://docs.ollama.com/api/openai-compatibility.md', sourceFile: 'src/integrations/openai.ts', interfaceName: 'OpenAIChatCompletionRequest', endpoint: '/v1/chat/completions', fields: ['model','messages','frequency_penalty','presence_penalty','response_format','seed','stop','stream','stream_options','temperature','top_p','max_tokens','tools','reasoning_effort','reasoning','tool_choice','logit_bias','user','n'] },
  { docsUrl: 'https://docs.ollama.com/api/openai-compatibility.md', sourceFile: 'src/integrations/openai.ts', interfaceName: 'OpenAICompletionRequest', endpoint: '/v1/completions', fields: ['model','prompt','frequency_penalty','presence_penalty','seed','stop','stream','stream_options','temperature','top_p','max_tokens','suffix','best_of','echo','logit_bias','user','n'] },
  { docsUrl: 'https://docs.ollama.com/api/openai-compatibility.md', sourceFile: 'src/integrations/openai.ts', interfaceName: 'OpenAIEmbeddingRequest', endpoint: '/v1/embeddings', fields: ['model','input','encoding_format','dimensions','user'] },
  { docsUrl: 'https://docs.ollama.com/api/openai-compatibility.md', sourceFile: 'src/integrations/openai.ts', interfaceName: 'OpenAIResponsesRequest', endpoint: '/v1/responses', fields: ['model','input','instructions','tools','stream','temperature','top_p','max_output_tokens','reasoning','think','previous_response_id','conversation','truncation'] },
  { docsUrl: 'https://docs.ollama.com/api/anthropic-compatibility.md', sourceFile: 'src/integrations/anthropic.ts', interfaceName: 'AnthropicMessagesRequest', endpoint: '/v1/messages', fields: ['model','max_tokens','messages','system','stream','temperature','top_p','top_k','stop_sequences','tools','thinking','output_config','tool_choice','metadata'] },
  { docsUrl: 'https://docs.ollama.com/api/chat.md', sourceFile: 'src/types.ts', interfaceName: 'ChatRequestOptions', endpoint: '/api/chat', fields: ['model','messages','tools','format','options','stream','think','keep_alive','logprobs','top_logprobs'] },
  { docsUrl: 'https://docs.ollama.com/api/generate.md', sourceFile: 'src/types.ts', interfaceName: 'GenerateRequestOptions', endpoint: '/api/generate', fields: ['model','prompt','suffix','images','format','system','stream','think','raw','keep_alive','options','logprobs','top_logprobs'] },
  { docsUrl: 'https://docs.ollama.com/api/embed.md', sourceFile: 'src/types.ts', interfaceName: 'EmbedRequestOptions', endpoint: '/api/embed', fields: ['model','input','truncate','dimensions','keep_alive','options'] },
  { docsUrl: 'https://docs.ollama.com/api/create.md', sourceFile: 'src/types.ts', interfaceName: 'CreateRequestOptions', endpoint: '/api/create', fields: ['model','from','template','renderer','parser','files','draft_files','license','system','parameters','messages','quantize','draft_quantize','requires','stream'] },
  { docsUrl: 'https://docs.ollama.com/api-reference/show-model-details.md', sourceFile: 'src/types.ts', interfaceName: 'ShowRequestOptions', endpoint: '/api/show', fields: ['model','verbose'] },
  { docsUrl: 'https://docs.ollama.com/api/tags.md', endpoint: '/api/tags', fields: [] },
  { docsUrl: 'https://docs.ollama.com/api/ps.md', endpoint: '/api/ps', fields: [] },
  { docsUrl: 'https://docs.ollama.com/api-reference/get-version.md', endpoint: '/api/version', fields: [] },
];

function sourceProperties(sourceFile: string, interfaceName: string): Set<string> {
  const sourcePath = resolve(ROOT, sourceFile);
  const source = readFileSync(sourcePath, 'utf8');
  const file = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const statement of file.statements) {
    if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== interfaceName) continue;
    return new Set(statement.members.flatMap((member) => {
      if (!ts.isPropertySignature(member) || !member.name) return [];
      if (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) return [member.name.text];
      return [];
    }));
  }
  throw new Error('Interface ' + interfaceName + ' was not found in ' + sourceFile);
}

async function fetchDocs(url: string): Promise<string> {
  const response = await fetch(url, { headers: { Accept: 'text/plain, text/markdown, */*' }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error('Failed to fetch ' + url + ': HTTP ' + response.status);
  return response.text();
}

function assertContract(contract: SurfaceContract, docs: string, properties: Set<string>): void {
  if (!docs.includes(contract.endpoint)) throw new Error('Documented endpoint ' + contract.endpoint + ' is missing from ' + contract.docsUrl);
  const missingSource = contract.fields.filter((field) => !properties.has(field));
  if (missingSource.length > 0) throw new Error(contract.interfaceName + ' is missing documented field(s): ' + missingSource.join(', '));
  const missingDocs = contract.fields.filter((field) => !docs.includes('`' + field + '`'));
  if (missingDocs.length > 0) throw new Error('Parity contract expects field(s) no longer documented by Ollama: ' + missingDocs.join(', '));
}

async function main(): Promise<void> {
  const docsCache = new Map<string, string>();
  for (const contract of CONTRACTS) {
    const sourceProps = contract.interfaceName && contract.sourceFile
      ? sourceProperties(contract.sourceFile, contract.interfaceName)
      : new Set<string>();
    let docs = docsCache.get(contract.docsUrl);
    if (docs === undefined) { docs = await fetchDocs(contract.docsUrl); docsCache.set(contract.docsUrl, docs); }
    assertContract(contract, docs, sourceProps);
    console.log('PASS ' + contract.endpoint + ' -> ' + contract.interfaceName + ' (' + contract.fields.length + ' fields)');
  }
  console.log('\nOllama compatibility API parity contract passed (' + CONTRACTS.length + ' surfaces).');
}

main().catch((error: unknown) => {
  console.error('\nOllama compatibility API parity FAILED:');
  console.error(error);
  process.exitCode = 1;
});