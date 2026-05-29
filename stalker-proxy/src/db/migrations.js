const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      run_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function getRunMigrations(client) {
  const result = await client.query('SELECT name FROM migrations ORDER BY name');
  return new Set(result.rows.map(row => row.name));
}

async function runMigrations() {
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const runMigrations = await getRunMigrations(client);

    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (runMigrations.has(file)) {
        console.log(`Skipping already-run migration: ${file}`);
        continue;
      }

      console.log(`Running migration: ${file}`);
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`Migration completed: ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }

    console.log('All migrations completed.');
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations().catch(err => {
  console.error(err);
  process.exit(1);
});

module.exports = { runMigrations };