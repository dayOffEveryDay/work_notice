import { readFile } from 'node:fs/promises';
// Preserve SQLite trigger bodies: a semicolon inside BEGIN...END is not a boundary.
export async function applyTestMigrations(db) {
  for (const file of ['0001_init.sql', '0002_android_fcm.sql', '0003_scheduled_activation.sql', '0004_agent_sources.sql']) {
    const sql = (await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8')).replace(/^--.*$/gm, '');
    // Match trigger starts after whitespace, rather than treating the first inner ';' as SQL end.
    const chunks = []; let pending = '', trigger = false;
    for (const line of sql.split('\n')) {
      pending += line + '\n';
      if (/^\s*CREATE TRIGGER/.test(line)) trigger = true;
      if (trigger ? /^END;\s*$/.test(line) : /;\s*$/.test(line)) { chunks.push(pending.trim()); pending = ''; trigger = false; }
    }
    if (pending.trim()) throw new Error('Incomplete migration statement');
    await db.batch(chunks.map(s => db.prepare(s)));
  }
}
