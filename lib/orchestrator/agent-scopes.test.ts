import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { AGENT_SCOPES, getAgentScope } from './agent-scopes.js';

const VALID = new Set(['chunked', 'pattern', 'command', 'synthesis', 'probe', 'hybrid']);

describe('agent-scopes', () => {
  it('every entry has a valid category', () => {
    for (const [name, scope] of Object.entries(AGENT_SCOPES)) {
      assert.ok(VALID.has(scope.category), `${name} has invalid category ${scope.category}`);
    }
  });

  it('pattern agents declare at least one glob pattern', () => {
    for (const [name, scope] of Object.entries(AGENT_SCOPES)) {
      if (scope.category === 'pattern') {
        assert.ok(scope.patterns && scope.patterns.length > 0, `${name} is pattern-scoped but has no patterns`);
      }
    }
  });

  it('probe agents declare a probeLabel', () => {
    for (const [name, scope] of Object.entries(AGENT_SCOPES)) {
      if (scope.category === 'probe') {
        assert.ok(scope.probeLabel, `${name} is probe category but has no probeLabel`);
      }
    }
  });

  it('getAgentScope falls back to pattern for unknown agents', () => {
    const scope = getAgentScope('some-nonexistent-agent');
    assert.equal(scope.category, 'pattern');
  });

  it('getAgentScope returns the mapped entry for known agents', () => {
    assert.equal(getAgentScope('build-verifier').category, 'command');
    assert.equal(getAgentScope('code-reviewer').category, 'chunked');
    assert.equal(getAgentScope('qa-gap-analyzer').category, 'synthesis');
    assert.equal(getAgentScope('api-contract-prober').category, 'probe');
    assert.equal(getAgentScope('rbac-reviewer').category, 'pattern');
  });
});
