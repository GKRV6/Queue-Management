'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SQL_DIR = path.join(__dirname, '..', 'db');
const SCHEMA_FILES = ['schema.sql', 'triggers.sql', 'views.sql'];

function readSql(file) {
  return fs.readFileSync(path.join(SQL_DIR, file), 'utf8');
}

/**
 * Opens (and if needed creates) the SQLite database.
 * Pass ':memory:' for an isolated in-memory database (tests).
 */
function openDatabase(filename) {
  if (filename !== ':memory:') {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
  }
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  if (filename !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  return db;
}

function hasSchema(db) {
  const row = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  return row.n > 0;
}

function createSchema(db) {
  for (const file of SCHEMA_FILES) db.exec(readSql(file));
}

/**
 * Runs fn inside a single IMMEDIATE transaction: the write lock is taken up
 * front, so two concurrent "join queue" requests can never compute the same
 * token number. Any thrown error rolls the whole unit back.
 */
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Parses db/queries.sql into named report definitions.
 */
function loadReportQueries() {
  const text = readSql('queries.sql');
  const blocks = text.split(/^-- name:\s*/m).slice(1);
  return blocks.map((block) => {
    const lines = block.split(/\r?\n/);
    const name = lines[0].trim();
    const meta = { name, title: name, concepts: '', description: '' };
    const sqlLines = [];
    for (const line of lines.slice(1)) {
      const m = line.match(/^-- (title|concepts|description):\s*(.*)$/);
      if (m) meta[m[1]] = m[2].trim();
      else sqlLines.push(line);
    }
    meta.sql = sqlLines.join('\n').trim().replace(/;\s*$/, '');
    return meta;
  });
}

module.exports = { openDatabase, hasSchema, createSchema, transaction, loadReportQueries, SCHEMA_FILES };
