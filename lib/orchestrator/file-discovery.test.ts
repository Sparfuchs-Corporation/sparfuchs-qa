import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';

import {
  EXCLUDE_DIRS,
  SOURCE_EXTENSIONS,
  discoverSourceFiles,
  countFilesByExtension,
  countAllFiles,
  excludePathArgsForFind,
  excludeDirArgsForGrep,
} from './file-discovery.js';

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'file-discovery-'));

  // Real project source
  mkdirSync(join(root, 'apps/admin/src/pages'), { recursive: true });
  writeFileSync(join(root, 'apps/admin/src/App.tsx'), 'export default {}');
  writeFileSync(join(root, 'apps/admin/src/pages/Login.tsx'), 'export default {}');

  mkdirSync(join(root, 'libs/shared'), { recursive: true });
  writeFileSync(join(root, 'libs/shared/index.ts'), 'export const x = 1');

  mkdirSync(join(root, 'services/api'), { recursive: true });
  writeFileSync(join(root, 'services/api/main.py'), 'def run(): pass')

  // Vendored Python env (the bug)
  mkdirSync(join(root, 'apps/ai-proxy/.venv/lib/python3.9/site-packages/PIL'), { recursive: true });
  writeFileSync(join(root, 'apps/ai-proxy/.venv/lib/python3.9/site-packages/PIL/Image.py'), '# vendored');
  writeFileSync(join(root, 'apps/ai-proxy/.venv/lib/python3.9/site-packages/PIL/ImageDraw.py'), '# vendored');

  // node_modules noise
  mkdirSync(join(root, 'node_modules/lodash'), { recursive: true });
  writeFileSync(join(root, 'node_modules/lodash/index.js'), 'module.exports = {}');

  // Python caches
  mkdirSync(join(root, 'services/api/.mypy_cache'), { recursive: true });
  writeFileSync(join(root, 'services/api/.mypy_cache/cache.json'), '{}');

  // Build output
  mkdirSync(join(root, 'apps/admin/dist'), { recursive: true });
  writeFileSync(join(root, 'apps/admin/dist/bundle.js'), '// compiled');

  // Module Federation temp
  mkdirSync(join(root, '.__mf__temp/forge_shell'), { recursive: true });
  writeFileSync(join(root, '.__mf__temp/forge_shell/localSharedImportMap.js'), '// federation');

  return root;
}

describe('file-discovery', () => {
  describe('EXCLUDE_DIRS', () => {
    it('includes .venv, venv, .tox, .mypy_cache, .ruff_cache', () => {
      for (const d of ['.venv', 'venv', '.tox', '.mypy_cache', '.ruff_cache', '.pytest_cache']) {
        assert.ok(EXCLUDE_DIRS.includes(d), `EXCLUDE_DIRS missing ${d}`);
      }
    });

    it('includes node_modules, dist, build, .git', () => {
      for (const d of ['node_modules', 'dist', 'build', '.git']) {
        assert.ok(EXCLUDE_DIRS.includes(d), `EXCLUDE_DIRS missing ${d}`);
      }
    });

    it('includes .__mf__temp, playwright-report, test-results', () => {
      for (const d of ['.__mf__temp', 'playwright-report', 'test-results']) {
        assert.ok(EXCLUDE_DIRS.includes(d), `EXCLUDE_DIRS missing ${d}`);
      }
    });
  });

  describe('discoverSourceFiles', () => {
    it('excludes .venv/** paths', () => {
      const root = makeFixture();
      try {
        const files = discoverSourceFiles(root);
        const hasVenv = files.some(f => f.includes('/.venv/'));
        assert.equal(hasVenv, false, `found .venv file: ${files.filter(f => f.includes('/.venv/')).join(', ')}`);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it('excludes node_modules/**', () => {
      const root = makeFixture();
      try {
        const files = discoverSourceFiles(root);
        const hasNm = files.some(f => f.includes('/node_modules/'));
        assert.equal(hasNm, false);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it('excludes .__mf__temp/**', () => {
      const root = makeFixture();
      try {
        const files = discoverSourceFiles(root);
        const hasMf = files.some(f => f.includes('.__mf__temp'));
        assert.equal(hasMf, false);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it('returns absolute paths', () => {
      const root = makeFixture();
      try {
        const files = discoverSourceFiles(root);
        assert.ok(files.length > 0, 'expected at least one real source file');
        for (const f of files) {
          assert.ok(isAbsolute(f), `expected absolute path, got ${f}`);
        }
      } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it('finds real project source (apps/, libs/, services/)', () => {
      const root = makeFixture();
      try {
        const files = discoverSourceFiles(root);
        assert.ok(files.some(f => f.endsWith('apps/admin/src/App.tsx')));
        assert.ok(files.some(f => f.endsWith('libs/shared/index.ts')));
        assert.ok(files.some(f => f.endsWith('services/api/main.py')));
      } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it('resolves relative repo paths against process.cwd()', () => {
      const root = makeFixture();
      try {
        const files = discoverSourceFiles(root);
        const expected = resolve(root);
        assert.ok(files.every(f => f.startsWith(expected)));
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  });

  describe('countFilesByExtension', () => {
    it('counts by extension excluding .venv', () => {
      const root = makeFixture();
      try {
        const counts = countFilesByExtension(root);
        // .py files exist at services/api/main.py only — .venv Python files are excluded
        assert.equal(counts.get('.py'), 1, `.py count should be 1 (services/api only), got ${counts.get('.py')}`);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  });

  describe('countAllFiles', () => {
    it('excludes node_modules, .venv, dist, .__mf__temp', () => {
      const root = makeFixture();
      try {
        const n = countAllFiles(root);
        // Real files: App.tsx, Login.tsx, index.ts, main.py = 4
        assert.equal(n, 4, `expected 4 real files, got ${n}`);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  });

  describe('excludePathArgsForFind / excludeDirArgsForGrep', () => {
    it('emits -not -path for every EXCLUDE_DIRS entry', () => {
      const s = excludePathArgsForFind();
      for (const d of EXCLUDE_DIRS) {
        assert.ok(s.includes(`-not -path "*/${d}/*"`), `missing -not -path for ${d}`);
      }
    });

    it('emits --exclude-dir for every EXCLUDE_DIRS entry', () => {
      const s = excludeDirArgsForGrep();
      for (const d of EXCLUDE_DIRS) {
        assert.ok(s.includes(`--exclude-dir=${d}`), `missing --exclude-dir for ${d}`);
      }
    });
  });

  describe('SOURCE_EXTENSIONS', () => {
    it('covers the major languages', () => {
      for (const ext of ['ts', 'tsx', 'py', 'go', 'rs', 'java', 'rb']) {
        assert.ok(SOURCE_EXTENSIONS.includes(ext), `missing ${ext}`);
      }
    });
  });
});
