import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATABASE_NAME = 'berthday';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const databaseId = (database) => database.uuid ?? database.id ?? database.database_id ?? '';
const databaseName = (database) => database.name ?? database.database_name;

// Always verify the account's database name, including when an ID is supplied.
// A typo in a secret must never point the seed at another application's database.
export async function resolveDatabase({ suppliedId = '', listDatabases, createDatabase }) {
  const id = suppliedId.trim();
  if (id && !UUID.test(id)) throw new Error('D1_DATABASE_ID must be a valid database UUID.');
  let databases = await listDatabases();
  if (!Array.isArray(databases)) throw new Error('Wrangler returned an invalid D1 database list.');
  if (id) {
    const database = databases.find((item) => databaseId(item).toLowerCase() === id.toLowerCase());
    if (!database) throw new Error('D1_DATABASE_ID was not found in the configured Cloudflare account.');
    if (databaseName(database) !== DATABASE_NAME) {
      throw new Error(`D1_DATABASE_ID points to "${databaseName(database)}"; the database must be named "${DATABASE_NAME}".`);
    }
    return databaseId(database);
  }
  let database = databases.find((item) => databaseName(item) === DATABASE_NAME);
  if (!database) {
    await createDatabase(DATABASE_NAME);
    databases = await listDatabases();
    database = databases.find((item) => databaseName(item) === DATABASE_NAME);
  }
  const resolvedId = database ? databaseId(database) : '';
  if (!UUID.test(resolvedId)) throw new Error(`Could not resolve a D1 database ID for ${DATABASE_NAME}.`);
  return resolvedId;
}

async function main() {
  const run = (args) => execFileSync('npx', ['wrangler', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  });
  const id = await resolveDatabase({
    suppliedId: process.env.D1_DATABASE_ID,
    listDatabases() {
      const output = run(['d1', 'list', '--json']);
      return JSON.parse(output.slice(output.indexOf('['), output.lastIndexOf(']') + 1));
    },
    createDatabase(name) {
      console.log(`Creating D1 database ${name}`);
      execFileSync('npx', ['wrangler', 'd1', 'create', name], { stdio: 'inherit' });
    },
  });
  const configPath = 'wrangler.jsonc';
  const config = readFileSync(configPath, 'utf8');
  const binding = /("database_name"\s*:\s*"berthday"\s*,\s*"database_id"\s*:\s*)"[^"]*"/;
  if (!binding.test(config)) throw new Error('Expected the berthday D1 binding in wrangler.jsonc.');
  writeFileSync(configPath, config.replace(binding, `$1"${id}"`));
  console.log(`D1 ${DATABASE_NAME} -> ${id}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
