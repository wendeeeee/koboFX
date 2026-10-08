// The first ADMIN and the first SECURITY officer (Phase 10 plan §E.1): once, over the schema OWNER's connection.
//
//   npm run admin:bootstrap -- --admin <userId> --security <userId>
//
// Two different, already registered and verified (ACTIVE) users. `bootstrap_first_administrators` refuses as
// soon as anybody has ever held a privileged role, so this cannot be repeated — every later role change is an
// approval (an ADMIN requests, a SECURITY officer approves). It writes the assignment records and audit rows
// itself. The runtime role (`fx_app`) cannot call it.
import 'reflect-metadata';
import 'dotenv/config';
import { DataSource } from 'typeorm';
import { loadConfig } from '../src/config/configuration';
import { buildDataSourceOptions } from '../src/database/data-source.options';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function bootstrapAdministrators(owner: DataSource, administratorId: string, securityOfficerId: string): Promise<void> {
  if (!UUID.test(administratorId) || !UUID.test(securityOfficerId)) throw new Error('Both --admin and --security must be user ids (UUIDs).');
  await owner.transaction(async (manager) => {
    await manager.query(`SELECT bootstrap_first_administrators($1, $2)`, [administratorId, securityOfficerId]);
  });
}

function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing --${name} <userId>.`);
  return value;
}

async function main(): Promise<void> {
  const owner = new DataSource(buildDataSourceOptions(loadConfig(process.env).db, 'migration'));
  await owner.initialize();
  try {
    const administratorId = argument('admin');
    const securityOfficerId = argument('security');
    await bootstrapAdministrators(owner, administratorId, securityOfficerId);
    process.stdout.write(`Bootstrapped ADMIN ${administratorId} and SECURITY ${securityOfficerId}.\n`);
  } finally {
    await owner.destroy();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`admin:bootstrap failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
