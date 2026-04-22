import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { RunStateSnapshot } from '../run-state.js';

/**
 * Writes RunStateSnapshot to active-run.json using atomic write (temp + rename).
 * For CI/piped mode and external consumers (sparfuchs status, future web dashboard).
 */
export class JsonRenderer {
  private readonly targetPath: string;

  constructor(targetDir?: string) {
    const dir = targetDir ?? join(process.env.HOME ?? '/tmp', '.sparfuchs-qa');
    mkdirSync(dir, { recursive: true });
    this.targetPath = join(dir, 'active-run.json');
  }

  render(snapshot: RunStateSnapshot): void {
    const tempPath = `${this.targetPath}.${Date.now()}.tmp`;
    try {
      writeFileSync(tempPath, JSON.stringify(snapshot, null, 2));
      renameSync(tempPath, this.targetPath);
    } catch {
      // Non-critical — status file is informational
      try { writeFileSync(this.targetPath, JSON.stringify(snapshot, null, 2)); } catch { /* give up */ }
    }
  }

  cleanup(): void {
    try {
      const { unlinkSync } = require('node:fs');
      unlinkSync(this.targetPath);
    } catch { /* file may not exist */ }
  }

  getPath(): string {
    return this.targetPath;
  }
}
