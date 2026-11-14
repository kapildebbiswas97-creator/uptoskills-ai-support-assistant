import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

test('PostgreSQL runtime role has only read access to the knowledge schema', async () => {
  const path = fileURLToPath(new URL('../infra/postgres/init/001-knowledge.sql', import.meta.url));
  const sql = await readFile(path, 'utf8');

  assert.match(sql, /CREATE ROLE uts_assistant_reader[\s\S]*NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT/i);
  assert.match(sql, /GRANT SELECT ON TABLE knowledge\.documents TO uts_assistant_reader/i);
  assert.doesNotMatch(sql, /GRANT\s+(?:INSERT|UPDATE|DELETE|ALL)\b/i);
});
