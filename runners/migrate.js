import Database from 'better-sqlite3';
import config from '../src/config.js';
import {
  findMigrations,
  loadMigration,
  acquireLock,
  releaseLock,
  getCurrentVersion,
  validateStepCount,
} from './migrate-utils.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const rollbackIndex = args.indexOf('--rollback');

let db;
try {
  db = new Database(config.dbPath);
  db.defaultSafeIntegers(true);
} catch (err) {
  console.error(`Error: cannot open database at ${config.dbPath}`);
  process.exit(1);
}

// Parse arguments
let steps;
if (rollbackIndex !== -1) {
  const rawSteps = rollbackIndex + 1 < args.length && !args[rollbackIndex + 1].startsWith('--')
    ? args[rollbackIndex + 1]
    : undefined;
  try {
    steps = validateStepCount(rawSteps);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
  if (steps === 0) {
    console.warn('Warning: 0 steps requested — nothing to do');
    process.exit(0);
  }
  await rollback(db, steps, dryRun);
} else {
  const rawSteps = args.find(a => /^\d+$/.test(a));
  try {
    steps = validateStepCount(rawSteps);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
  if (steps === 0) {
    console.warn('Warning: 0 steps requested — nothing to do');
    process.exit(0);
  }
  await migrate(db, steps, dryRun);
}

async function migrate(db, steps, dryRun) {
  try {
    if (!acquireLock(db)) {
      console.error('Migration lock held by another process. Try again later.');
      process.exit(1);
    }

    const currentVersion = getCurrentVersion(db);
    const migrations = findMigrations();
    const pending = [];

    for (const m of migrations) {
      const mod = await loadMigration(m.filepath);
      if (mod.version > currentVersion) {
        pending.push(mod);
      }
    }

    const toRun = steps === Infinity ? pending : pending.slice(0, steps);

    if (toRun.length === 0) {
      console.log('Already up to date.');
      releaseLock(db);
      return;
    }

    if (dryRun) {
      console.log('Pending migrations:');
      for (const m of toRun) {
        console.log(`  ${m.version.toString().padStart(22)}  ${m.description}`);
      }
      releaseLock(db);
      return;
    }

    for (const m of toRun) {
      console.log(`Running: ${m.description}`);
      db.transaction(() => {
        m.up(db);
        db.prepare('INSERT INTO _schema_version (version, applied_at) VALUES (?, ?)')
          .run(m.version, Date.now());
      })();
      console.log(`  OK (v${m.version.toString()})`);
    }

    releaseLock(db);
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  }
}

async function rollback(db, steps, dryRun) {
  try {
    if (!acquireLock(db)) {
      console.error('Migration lock held by another process.');
      process.exit(1);
    }

    const applied = db.prepare(
      'SELECT version FROM _schema_version ORDER BY version DESC LIMIT ?'
    ).all(steps);

    if (applied.length === 0) {
      console.log('Nothing to roll back.');
      releaseLock(db);
      return;
    }

    const migrations = findMigrations();
    const mods = await Promise.all(migrations.map(m => loadMigration(m.filepath)));
    const versionMap = new Map();
    for (const m of mods) {
      versionMap.set(m.version.toString(), m);
    }

    if (dryRun) {
      console.log('Would roll back:');
      for (const a of applied) {
        const v = a.version.toString();
        const m = versionMap.get(v);
        console.log(`  ${v.padStart(22)}  ${m ? m.description : 'unknown'}`);
      }
      releaseLock(db);
      return;
    }

    for (const a of applied) {
      const v = a.version.toString();
      const m = versionMap.get(v);
      if (!m || !m.down) {
        console.warn(`  Warning: no down() for version ${v}, skipping`);
        continue;
      }
      console.log(`Rolling back: ${m.description}`);
      db.transaction(() => {
        m.down(db);
        db.prepare('DELETE FROM _schema_version WHERE version = ?').run(a.version);
      })();
      console.log(`  OK (v${v})`);
    }

    releaseLock(db);
  } catch (err) {
    console.error('Rollback failed:', err.message);
    process.exit(1);
  }
}
