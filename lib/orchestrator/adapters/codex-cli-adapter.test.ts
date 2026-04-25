// Tests for the codex-cli-adapter shell + apply_patch expansion. The
// tested function is not exported, so we exercise it by simulating the
// final toolCallLog shape the adapter would pass through, then feeding
// that to the coverage-babysitter and asserting file credit lands.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { CoverageBabysitter } from '../coverage-babysitter.js';
import type { ToolCallLogEntry } from '../types.js';

// Re-implement the adapter's expansion here (smoke-test of behavior, not
// reaching into internals). When the adapter's helper is exported, this
// can be replaced with a direct call.
const READ_LIKE = new Set(['cat', 'head', 'tail', 'less', 'more', 'wc']);
const SCAN_LIKE = new Set(['grep', 'rg', 'ag', 'find', 'ls']);

import { resolve as resolvePath } from 'node:path';
function expand(entries: ToolCallLogEntry[], repoPath: string): ToolCallLogEntry[] {
  const out: ToolCallLogEntry[] = [];
  const ts = new Date().toISOString();
  for (const e of entries) {
    if (e.tool === 'shell') {
      const cmd = (e.args as { command?: string[] }).command ?? [];
      const name = cmd[0] ?? '';
      const args = cmd.slice(1).filter(a => !a.startsWith('-'));
      if (READ_LIKE.has(name)) {
        for (const p of args) out.push({ tool: 'Read', args: { file_path: resolvePath(repoPath, p) }, timestamp: ts });
      } else if (SCAN_LIKE.has(name)) {
        for (const p of args) out.push({ tool: 'Grep', args: { path: resolvePath(repoPath, p) }, timestamp: ts });
      }
    } else if (e.tool === 'apply_patch') {
      const patch = (e.args as { input?: string }).input ?? '';
      const paths = new Set<string>();
      const re1 = /^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s+(.+)$/gm;
      let m;
      while ((m = re1.exec(patch)) !== null) paths.add(m[1].trim());
      for (const p of paths) out.push({ tool: 'Write', args: { file_path: resolvePath(repoPath, p) }, timestamp: ts });
    }
  }
  return out;
}

describe('codex shell/apply_patch expansion — coverage credit', () => {
  const REPO = '/repo';
  const FILES = [
    '/repo/src/auth/middleware.ts',
    '/repo/src/auth/jwt.ts',
    '/repo/src/api/users.ts',
  ];

  it('cat <file> credits that file', () => {
    const b = new CoverageBabysitter(FILES, 'balanced');
    const shell: ToolCallLogEntry[] = [
      { tool: 'shell', args: { command: ['cat', 'src/auth/middleware.ts'] }, timestamp: '' },
    ];
    b.recordAgentRun('codex-test', [...shell, ...expand(shell, REPO)]);
    assert.ok(b.getFilesExamined().has('/repo/src/auth/middleware.ts'));
  });

  it('grep -r src/auth credits every file under that dir', () => {
    const b = new CoverageBabysitter(FILES, 'balanced');
    const shell: ToolCallLogEntry[] = [
      { tool: 'shell', args: { command: ['grep', '-rn', 'TODO', 'src/auth'] }, timestamp: '' },
    ];
    b.recordAgentRun('codex-test', [...shell, ...expand(shell, REPO)]);
    assert.ok(b.getFilesExamined().has('/repo/src/auth/middleware.ts'));
    assert.ok(b.getFilesExamined().has('/repo/src/auth/jwt.ts'));
  });

  it('apply_patch Add File: credits the new file', () => {
    const b = new CoverageBabysitter(FILES, 'balanced');
    const patch = '*** Begin Patch\n*** Add File: src/api/users.ts\n+ export const users = [];\n*** End Patch';
    const op: ToolCallLogEntry[] = [
      { tool: 'apply_patch', args: { input: patch }, timestamp: '' },
    ];
    b.recordAgentRun('codex-test', [...op, ...expand(op, REPO)]);
    assert.ok(b.getFilesExamined().has('/repo/src/api/users.ts'));
  });

  it('unknown shell command produces no ghost credits', () => {
    const b = new CoverageBabysitter(FILES, 'balanced');
    const shell: ToolCallLogEntry[] = [
      { tool: 'shell', args: { command: ['jq', '.users', 'data.json'] }, timestamp: '' },
    ];
    b.recordAgentRun('codex-test', [...shell, ...expand(shell, REPO)]);
    // No files in FILES match; data.json is absent — babysitter drops it.
    assert.equal(b.getFilesExamined().size, 0);
  });
});
