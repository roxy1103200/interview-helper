import { DatabaseSync } from 'node:sqlite';
import type { Knowledge, Match, SessionSummary } from '../../shared/contracts';
import { normalize, tokens } from '../../shared/text';

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS knowledge(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(id UNINDEXED, title, keywords, answer);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, startedAt INTEGER, endedAt INTEGER, status TEXT, settings TEXT);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, sessionId TEXT REFERENCES sessions(id), kind TEXT, createdAt INTEGER, body TEXT);
      CREATE INDEX IF NOT EXISTS events_session ON events(sessionId, createdAt);
      PRAGMA user_version=1;`);
    this.db
      .prepare(
        "UPDATE sessions SET status='interrupted', endedAt=COALESCE(endedAt, ?) WHERE endedAt IS NULL",
      )
      .run(Date.now());
  }
  list(): Knowledge[] {
    return (
      this.db.prepare('SELECT body FROM knowledge ORDER BY id').all() as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }
  upsert(entries: Knowledge[]) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const entry of entries) {
        this.db
          .prepare('INSERT OR REPLACE INTO knowledge VALUES(?,?)')
          .run(entry.id, JSON.stringify(entry));
        this.db.prepare('DELETE FROM knowledge_fts WHERE id=?').run(entry.id);
        if (entry.enabled)
          this.db
            .prepare('INSERT INTO knowledge_fts VALUES(?,?,?,?)')
            .run(
              entry.id,
              tokens(entry.title).join(' '),
              tokens(entry.keywords.join(' ')).join(' '),
              tokens(entry.answer).join(' '),
            );
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  remove(id: string) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM knowledge WHERE id=?').run(id);
      this.db.prepare('DELETE FROM knowledge_fts WHERE id=?').run(id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  search(question: string): Match[] {
    const query = tokens(question)
      .slice(0, 32)
      .map((t) => '"' + t.replace(/"/g, '""') + '"')
      .join(' OR ');
    const ranked = query
      ? (this.db
          .prepare(
            'SELECT id, bm25(knowledge_fts,0,4,5,1) score FROM knowledge_fts WHERE knowledge_fts MATCH ? ORDER BY score LIMIT 15',
          )
          .all(query) as { id: string; score: number }[])
      : [];
    const lexical = new Map(ranked.map((r, i) => [r.id, 1 / (i + 1)]));
    const q = normalize(question);
    const matches = this.list()
      .filter((e) => e.enabled)
      .map((entry) => {
        const hits = entry.keywords.filter((k) => q.includes(normalize(k)));
        const exact = normalize(entry.title) === q;
        const score =
          hits.reduce((s, k) => s + Math.min(10, normalize(k).length), 0) * 10 +
          (exact ? 1000 : 0) +
          (lexical.get(entry.id) ?? 0);
        return { ...entry, score, direct: exact || hits.length > 0 };
      })
      .filter((e) => e.score > 0)
      .sort((a, b) => b.score - a.score);
    const top = matches[0];
    if (top && matches[1] && top.score < matches[1].score * 1.3) top.direct = false;
    return matches.slice(0, 3);
  }
  start(id: string, settings: unknown) {
    this.db
      .prepare('INSERT INTO sessions VALUES(?,?,NULL,?,?)')
      .run(id, Date.now(), 'active', JSON.stringify(settings));
  }
  end(id: string, status: string) {
    this.db
      .prepare('UPDATE sessions SET endedAt=?,status=? WHERE id=?')
      .run(Date.now(), status, id);
  }
  event(id: string, sessionId: string, kind: string, body: unknown) {
    this.db
      .prepare('INSERT OR REPLACE INTO events VALUES(?,?,?,?,?)')
      .run(id, sessionId, kind, Date.now(), JSON.stringify(body));
  }
  sessions(): SessionSummary[] {
    return this.db
      .prepare('SELECT id,startedAt,endedAt,status FROM sessions ORDER BY startedAt DESC LIMIT 100')
      .all() as unknown as SessionSummary[];
  }
  history(id: string): { kind: string; body: unknown; createdAt: number }[] {
    return (
      this.db
        .prepare(
          'SELECT kind,body,createdAt FROM events WHERE sessionId=? ORDER BY createdAt,rowid',
        )
        .all(id) as { kind: string; body: string; createdAt: number }[]
    ).map((r) => ({ ...r, body: JSON.parse(r.body) }));
  }
  close() {
    this.db.close();
  }
}
