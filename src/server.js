'use strict';

const path = require('node:path');
const { openDatabase, hasSchema, createSchema } = require('./db');
const { closeStaleQueues } = require('./services/queueService');
const { seedDatabase, DEMO_ACCOUNTS } = require('./seed/seed');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'qws.db');
const ROLLOVER_CHECK_MS = 10 * 60 * 1000;
// Demo accounts and sample traffic are generated unless this is a production
// deployment (set SEED_DEMO=1 to force them in production too).
const SEED_DEMO = process.env.NODE_ENV !== 'production' || process.env.SEED_DEMO === '1';

function start() {
  const db = openDatabase(DB_FILE);
  if (!hasSchema(db)) {
    console.log('No database found - creating schema...');
    createSchema(db);
    if (SEED_DEMO) {
      const summary = seedDatabase(db);
      console.log(`Seeded ${summary.users} users and ${summary.tokens} tokens.`);
    }
  }
  const rollover = () => {
    const closed = closeStaleQueues(db);
    if (closed) console.log(`Closed ${closed} queue(s) left open from previous days.`);
  };
  rollover();
  const rolloverTimer = setInterval(rollover, ROLLOVER_CHECK_MS);

  const app = createApp(db);
  const server = app.listen(PORT, () => {
    console.log(`\nQueue Without Standing is running at http://localhost:${PORT}`);
    if (!SEED_DEMO) return;
    console.log('Demo logins:');
    for (const [role, acc] of Object.entries(DEMO_ACCOUNTS)) {
      console.log(`  ${role.padEnd(9)} ${acc.email.padEnd(18)} ${acc.password}`);
    }
  });

  const shutdown = () => {
    clearInterval(rolloverTimer);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start();
