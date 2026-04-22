import { unlinkSync, existsSync } from 'node:fs';
import { basename } from 'node:path';

const SAFE_PREFIX = 'sparfuchs-qa-creds-';

function isValidCredPath(filePath: string): boolean {
  return filePath.startsWith('/tmp/') && basename(filePath).startsWith(SAFE_PREFIX);
}

function main(): void {
  // Check if credentials came from keychain — nothing to clean up
  if (process.argv.includes('--source') && process.argv.includes('keychain')) {
    console.log('Credentials loaded from keychain \u2014 no temp file to clean up.');
    return;
  }

  const filePath = process.argv[2];

  if (!filePath) {
    console.error('Usage: npx tsx lib/credentials/teardown.ts <credential-file-path>');
    console.error('       npx tsx lib/credentials/teardown.ts --source keychain');
    process.exit(1);
  }

  if (!isValidCredPath(filePath)) {
    console.error(`Refusing to delete "${filePath}" \u2014 path must be /tmp/${SAFE_PREFIX}*`);
    process.exit(1);
  }

  if (!existsSync(filePath)) {
    console.log(`Credential file already removed: ${filePath}`);
    return;
  }

  unlinkSync(filePath);
  console.log(`Credential file deleted: ${filePath}`);
}

main();
