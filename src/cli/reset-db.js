'use strict';

// Deletes the database file and rebuilds it from db/*.sql with fresh sample data.
//   npm run db:reset             -> 21 days of history
//   npm run db:reset -- --days 7 -> 7 days of history

const fs = require('node:fs');
const path = require('node:path');
const { openDatabase, createSchema } = require('../db');
const { seedDatabase } = require('../seed/seed');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', '..', 'data', 'qws.db');
const daysArg = process.argv.indexOf('--days');
const days = daysArg > -1 ? Number(process.argv[daysArg + 1]) : 21;

if (!Number.isInteger(days) || days < 0 || days > 120) {
  console.error('--days must be a whole number between 0 and 120');
  process.exit(1);
}

for (const suffix of ['', '-wal', '-shm']) {
  fs.rmSync(DB_FILE + suffix, { force: true });
}

const started = Date.now();
const db = openDatabase(DB_FILE);
createSchema(db);
const summary = seedDatabase(db, { days });
db.close();
console.log(`Database rebuilt at ${DB_FILE}`);
console.log(`  ${summary.users} users, ${summary.tokens} tokens, ${days} days of history (${Date.now() - started} ms)`);
