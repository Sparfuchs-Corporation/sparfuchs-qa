import * as path from 'path';

/**
 * Dynamic project identity resolution.
 *
 * Resolution order (first non-empty wins):
 *   1. PROJECT env var          — explicit override (e.g. --project flag)
 *   2. TARGET_REPO env var      — basename of the target repository path
 *   3. process.cwd()            — basename of the current working directory
 */
export function getProjectId(): string {
  const explicit = process.env.PROJECT?.trim();
  if (explicit) return explicit;

  const targetRepo = process.env.TARGET_REPO?.trim();
  if (targetRepo) return path.basename(path.resolve(targetRepo));

  return path.basename(process.cwd());
}

/**
 * Slug-safe variant: lowercased, non-alphanumeric chars replaced with hyphens.
 * Used for filesystem paths (qa-data/<slug>/runs/…) and report identifiers.
 */
export function getProjectSlug(): string {
  return slugify(getProjectId());
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
