import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import config from '../src/config.js';
import { findMigrations, loadMigration } from './migrate-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');
const args = process.argv.slice(2);
const subcommand = args[0];

if (subcommand === 'create') {
  const nameParts = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) break;
    nameParts.push(args[i]);
  }
  const rawName = nameParts.join(' ').trim();

  if (!rawName) {
    console.error('Error: migration name is required');
    console.error('Usage: npm run migration create "<name>"');
    process.exit(1);
  }

  if (!/[a-zA-Z0-9]/.test(rawName)) {
    console.error('Error: migration name must contain at least one alphanumeric character');
    process.exit(1);
  }

  if (/[^a-zA-Z0-9\s_-]/.test(rawName)) {
    console.error('Error: migration name may only contain letters, digits, spaces, hyphens, and underscores');
    process.exit(1);
  }

  const slug = rawName
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();

  const ns = BigInt(Date.now()) * 1_000_000n;
  const filename = `${ns}-${slug}.js`;
  const filepath = path.join(MIGRATIONS_DIR, filename);

  const template = `export const version = ${ns}n;
export const description = '${rawName}';

export function up(db) {
  // TODO: apply migration
}

export function down(db) {
  // TODO: revert migration
}
`;

  fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
  fs.writeFileSync(filepath, template, 'utf-8');
  console.log(`Created: ${filename}`);

} else if (subcommand === 'status') {
  let db;
  try {
    db = new Database(config.dbPath);
    db.defaultSafeIntegers(true);
  } catch {
    console.log('No database found. Run `npm run migrate` to initialize.');
    process.exit(0);
  }

  const appliedRows = db.prepare('SELECT version, applied_at FROM _schema_version ORDER BY version').all();
  const appliedVersions = new Set(appliedRows.map(r => r.version.toString()));
  const migrations = findMigrations();
  const mods = await Promise.all(migrations.map(m => loadMigration(m.filepath)));

  mods.sort((a, b) => {
    if (a.version > b.version) return 1;
    if (a.version < b.version) return -1;
    return 0;
  });

  console.log('Migration status:');
  for (const m of mods) {
    const key = m.version.toString();
    const status = appliedVersions.has(key) ? '[applied]' : '[pending]';
    console.log(`  ${key.padStart(22)}  ${status}  ${m.description}`);
  }

  const pendingCount = mods.filter(m => !appliedVersions.has(m.version.toString())).length;
  console.log(`\n${appliedRows.length} applied, ${pendingCount} pending`);

} else {
  console.error('Usage:');
  console.error('  npm run migration create "<name>"');
  console.error('  npm run migration status');
  process.exit(1);
}
