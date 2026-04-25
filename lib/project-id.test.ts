import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import * as path from 'path';
import { getProjectId, getProjectSlug, slugify } from './project-id.js';

describe('getProjectId', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.PROJECT;
    delete process.env.TARGET_REPO;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns PROJECT env var when set', () => {
    process.env.PROJECT = 'my-custom-project';
    assert.equal(getProjectId(), 'my-custom-project');
  });

  it('trims whitespace around PROJECT', () => {
    process.env.PROJECT = '  spaced  ';
    assert.equal(getProjectId(), 'spaced');
  });

  it('prefers PROJECT over TARGET_REPO', () => {
    process.env.PROJECT = 'explicit';
    process.env.TARGET_REPO = '/tmp/derived-name';
    assert.equal(getProjectId(), 'explicit');
  });

  it('derives from TARGET_REPO basename when PROJECT not set', () => {
    process.env.TARGET_REPO = '/Users/jhewgley/dev/local/nerdminer-command-center';
    assert.equal(getProjectId(), 'nerdminer-command-center');
  });

  it('strips trailing slash from TARGET_REPO', () => {
    process.env.TARGET_REPO = '/tmp/my-app/';
    assert.equal(getProjectId(), 'my-app');
  });

  it('resolves relative TARGET_REPO', () => {
    process.env.TARGET_REPO = '.';
    assert.equal(getProjectId(), path.basename(process.cwd()));
  });

  it('falls back to cwd basename when nothing set', () => {
    assert.equal(getProjectId(), path.basename(process.cwd()));
  });

  it('treats empty PROJECT as unset', () => {
    process.env.PROJECT = '';
    process.env.TARGET_REPO = '/tmp/fallback';
    assert.equal(getProjectId(), 'fallback');
  });

  it('treats whitespace-only PROJECT as unset', () => {
    process.env.PROJECT = '   ';
    process.env.TARGET_REPO = '/tmp/fallback';
    assert.equal(getProjectId(), 'fallback');
  });

  it('never returns the legacy hardcoded value', () => {
    process.env.TARGET_REPO = '/tmp/nerdminer-command-center';
    const id = getProjectId();
    assert.notEqual(id, 'the-forge', 'projectId should derive from env, not be hardcoded to the-forge');
    assert.equal(id, 'nerdminer-command-center');
  });
});

describe('slugify', () => {
  it('lowercases and replaces non-alphanumeric chars with hyphens', () => {
    assert.equal(slugify('My Cool Project'), 'my-cool-project');
  });

  it('collapses consecutive special chars into a single hyphen', () => {
    assert.equal(slugify('foo---bar___baz'), 'foo-bar-baz');
  });

  it('strips leading and trailing hyphens', () => {
    assert.equal(slugify('---hello---'), 'hello');
  });

  it('handles already-clean slugs as no-ops', () => {
    assert.equal(slugify('nerdminer-command-center'), 'nerdminer-command-center');
  });

  it('handles mixed case with dots and underscores', () => {
    assert.equal(slugify('My.App_V2'), 'my-app-v2');
  });
});

describe('getProjectSlug', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.PROJECT;
    delete process.env.TARGET_REPO;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns a slugified version of the project id', () => {
    process.env.PROJECT = 'My Cool Project';
    assert.equal(getProjectSlug(), 'my-cool-project');
  });

  it('slugifies TARGET_REPO basename', () => {
    process.env.TARGET_REPO = '/tmp/My_App.V2/';
    assert.equal(getProjectSlug(), 'my-app-v2');
  });

  it('passes through already-clean names unchanged', () => {
    process.env.PROJECT = 'nerdminer-command-center';
    assert.equal(getProjectSlug(), 'nerdminer-command-center');
  });
});
