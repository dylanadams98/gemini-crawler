import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = process.env.DB_PATH || './data/crawler.db';
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS sites (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    domain     TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS terms (
    id         INTEGER PRIMARY KEY,
    site_id    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    term       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (site_id, term)
  );

  CREATE TABLE IF NOT EXISTS results (
    id              INTEGER PRIMARY KEY,
    term_id         INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
    crawled_at      TEXT NOT NULL DEFAULT (datetime('now')),
    has_overview    INTEGER NOT NULL,
    cited           INTEGER NOT NULL DEFAULT 0,
    cited_position  INTEGER,
    mentioned       INTEGER NOT NULL DEFAULT 0,
    overview_text   TEXT,
    references_json TEXT,
    raw_json        TEXT,
    error           TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_results_term ON results(term_id, crawled_at);

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

export function getMeta(key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}

export function setMeta(key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}
