import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { generateText } from 'ai';
import type { DocClaim, DocClaimType, ModelsYaml, ApiProviderName } from './types.js';
import { isApiProvider } from './types.js';
import type { ProviderRegistry } from './provider-registry.js';

const API_PROVIDER_NAMES = new Set<string>(['xai', 'google', 'anthropic', 'openai']);

const MAX_CHUNK_CHARS = 30_000;
const OVERLAP_CHARS = 2_000;

// --- Public API ---

/**
 * Process reference documents: extract text, extract claims, write manifest.
 * Returns the path to the claims.jsonl manifest.
 */
export async function processReferenceDocs(
  paths: string[],
  runDir: string,
  modelsConfig: ModelsYaml,
  registry?: ProviderRegistry,
): Promise<string> {
  const allClaims: DocClaim[] = [];

  for (const filePath of paths) {
    const trimmed = filePath.trim();
    if (!trimmed) continue;

    process.stderr.write(`  Extracting text from: ${basename(trimmed)}\n`);
    const { filename, text } = extractDocumentText(trimmed);

    if (text.length < 50) {
      process.stderr.write(`  WARNING: Very little text extracted from ${filename} (${text.length} chars)\n`);
      continue;
    }

    process.stderr.write(`  Extracting claims from: ${filename} (${text.length} chars)\n`);
    const claims = await extractClaims(text, filename, modelsConfig, registry);
    allClaims.push(...claims);
    process.stderr.write(`  Found ${claims.length} verifiable claims in ${filename}\n`);
  }

  // Write claims manifest as JSONL
  const manifestPath = join(runDir, 'claims.jsonl');
  const lines = allClaims.map(c => JSON.stringify(c));
  writeFileSync(manifestPath, lines.join('\n') + '\n');

  process.stderr.write(`Claims manifest: ${allClaims.length} total claims -> ${manifestPath}\n`);
  return manifestPath;
}

// --- Document Text Extraction ---

export function extractDocumentText(filePath: string): { filename: string; text: string } {
  if (!existsSync(filePath)) {
    throw new Error(`Reference document not found: ${filePath}`);
  }

  const ext = extname(filePath).toLowerCase();
  const filename = basename(filePath);

  switch (ext) {
    case '.md':
    case '.txt':
    case '.rst':
      return { filename, text: readFileSync(filePath, 'utf8') };

    case '.json':
      return { filename, text: readFileSync(filePath, 'utf8') };

    case '.pdf':
      return { filename, text: extractPdfText(filePath) };

    case '.docx':
      return { filename, text: extractDocxText(filePath) };

    default:
      // Try reading as plain text
      try {
        return { filename, text: readFileSync(filePath, 'utf8') };
      } catch {
        throw new Error(`Unsupported document format: ${ext}`);
      }
  }
}

function extractPdfText(filePath: string): string {
  // Dynamic import of pdf-parse (optional dependency)
  try {
    // pdf-parse is a CommonJS module; require it at runtime
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfParse = require('pdf-parse');
    const buffer = readFileSync(filePath);
    // pdf-parse returns a promise; we need to handle it synchronously for simplicity
    // In the actual async flow, the caller awaits processReferenceDocs
    let text = '';
    // NOTE: This is called from an async context, but pdf-parse returns a promise.
    // Spawn a short-lived Node subprocess to do the extraction synchronously.
    // Using execFileSync (no shell) with the path passed via env — this
    // eliminates the shell-escaping burden and CodeQL's
    // js/incomplete-sanitization concerns on the previous template-string
    // interpolation. The -e script is a constant; the only variable input
    // (filePath) travels through PDF_PATH, never through argv.
    const { execFileSync } = require('child_process');
    const script =
      "const fs = require('fs');" +
      "const pdfParse = require('pdf-parse');" +
      "const buffer = fs.readFileSync(process.env.PDF_PATH);" +
      "pdfParse(buffer).then(d => process.stdout.write(d.text)).catch(() => process.exit(1));";
    text = execFileSync('node', ['-e', script], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000,
      env: { ...process.env, PDF_PATH: filePath },
    });
    return text;
  } catch {
    process.stderr.write('  WARNING: pdf-parse not available. Install with: npm i pdf-parse\n');
    return `[PDF text extraction failed for ${basename(filePath)}. Install pdf-parse: npm i pdf-parse]`;
  }
}

function extractDocxText(filePath: string): string {
  // DOCX is a ZIP containing word/document.xml.
  // Use execFileSync (no shell) with argv passing — the filePath is a
  // direct argument to `unzip`, never interpolated into a shell command.
  // This closes CodeQL js/incomplete-sanitization on the old execSync
  // + .replace(/"/g,'\\"') pattern.
  try {
    const { execFileSync } = require('child_process');
    const xml: string = execFileSync(
      'unzip',
      ['-p', filePath, 'word/document.xml'],
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    // Text extraction pipeline. Order is deliberate and matters for
    // correctness of DOCX content with user-entered "<", ">", "&":
    //   1. Replace structural Word tags we care about with whitespace.
    //   2. Strip any remaining XML tags.
    //   3. THEN decode XML entities so literal user text surfaces.
    // This output is consumed by an LLM as prompt context, never
    // rendered as HTML, so decoded < / > characters cannot re-introduce
    // an injection sink. The final .trim is idempotent.
    return stripDocxXml(xml);
  } catch {
    return `[DOCX text extraction failed for ${basename(filePath)}]`;
  }
}

/**
 * Multi-step text extraction that is safe-by-context for LLM prompt consumption.
 * Separated into a function so the CodeQL suppression has a narrow footprint.
 */
// Keep angle brackets entity-escaped so tag-like text cannot be reintroduced
// after XML tag stripping.
function stripDocxXml(xml: string): string {
  return xml
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- Claim Extraction via LLM ---

async function extractClaims(
  docText: string,
  filename: string,
  modelsConfig: ModelsYaml,
  registry?: ProviderRegistry,
): Promise<DocClaim[]> {
  // Chunk large documents
  const chunks = chunkText(docText, MAX_CHUNK_CHARS, OVERLAP_CHARS);
  const allClaims: DocClaim[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkLabel = chunks.length > 1 ? ` (chunk ${i + 1}/${chunks.length})` : '';

    try {
      const claims = await extractClaimsFromChunk(chunk, filename, chunkLabel, modelsConfig, registry);
      allClaims.push(...claims);
    } catch (err) {
      process.stderr.write(`  WARNING: Claim extraction failed for ${filename}${chunkLabel}: ${err}\n`);
    }
  }

  // Deduplicate by claim text similarity
  return deduplicateClaims(allClaims);
}

async function extractClaimsFromChunk(
  text: string,
  filename: string,
  chunkLabel: string,
  modelsConfig: ModelsYaml,
  registry?: ProviderRegistry,
): Promise<DocClaim[]> {
  if (!registry) throw new Error('No provider registry — cannot extract claims without API access');

  // Ref-doc extraction requires an API provider (calls generateText directly)
  let provider = modelsConfig.defaultProvider;
  if (!API_PROVIDER_NAMES.has(provider)) {
    const fallback = modelsConfig.fallbackChain.find(p => API_PROVIDER_NAMES.has(p) && modelsConfig.providers[p]?.enabled);
    if (!fallback) throw new Error('No API provider available for ref-doc claim extraction');
    provider = fallback;
  }
  const apiProvider = provider as ApiProviderName;
  const modelName = modelsConfig.tiers.mid[apiProvider];
  const model = registry.createModel(apiProvider, modelName, `ref-doc-${filename}`);

  const prompt = `Extract every verifiable factual claim from this document. For each claim, output a JSON object on its own line (JSONL format).

Each JSON object must have these fields:
- "sourceSection": the section heading or "General" if no heading
- "claimType": one of: behavior, architecture, workflow, security, api-contract, data-model, config, integration, marketing
- "claim": the assertion in one clear sentence
- "verifiable": true if this can be checked against source code, false if it requires runtime testing
- "keywords": array of 3-5 search terms to find relevant code

Rules:
- Only extract claims that are EXPLICITLY stated in the document. Do not infer or extrapolate.
- Skip vague statements, opinions, and aspirational language.
- Focus on factual assertions about: what the system does, how it's built, what endpoints exist, what security measures are in place, what workflows exist.
- For marketing content: extract specific feature claims ("supports real-time chat"), performance claims ("handles 10K concurrent users"), and integration claims ("integrates with Salesforce").

Document: ${filename}${chunkLabel}

---
${text}
---

Output ONLY valid JSONL (one JSON object per line). No other text.`;

  const result = await generateText({
    model,
    prompt,
    temperature: 0.1,
  });

  const claims: DocClaim[] = [];
  for (const line of result.text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('```') || trimmed.startsWith('#')) continue;

    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.claim && parsed.claimType) {
        const id = createHash('sha256')
          .update(`${filename}:${parsed.sourceSection}:${parsed.claim}`)
          .digest('hex')
          .slice(0, 16);

        claims.push({
          id,
          sourceDoc: filename,
          sourceSection: parsed.sourceSection ?? 'General',
          claimType: parsed.claimType as DocClaimType,
          claim: parsed.claim,
          verifiable: parsed.verifiable ?? true,
          keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
        });
      }
    } catch {
      // Skip malformed lines
    }
  }

  return claims;
}

// --- Utilities ---

function chunkText(text: string, maxChars: number, overlap: number): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + maxChars, text.length);
    chunks.push(text.slice(start, end));

    if (end >= text.length) break;
    start = end - overlap;
  }

  return chunks;
}

function deduplicateClaims(claims: DocClaim[]): DocClaim[] {
  const seen = new Map<string, DocClaim>();

  for (const claim of claims) {
    // Normalize claim text for deduplication
    const key = claim.claim.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!seen.has(key)) {
      seen.set(key, claim);
    }
  }

  return [...seen.values()];
}
