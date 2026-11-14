import 'dotenv/config';
import { Pool } from 'pg';
import { EMBEDDING_MODEL, embedText } from './embeddings';
import { loadKnowledge } from './assistant';
import { vectorLiteral } from './database';

async function seedKnowledge() {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl) throw new Error('DATABASE_ADMIN_URL is required for this one-time knowledge seed');
  const pool = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    const knowledge = await loadKnowledge();
    for (const topic of knowledge.topics) {
      const embedding = await embedText(topic.content);
      await pool.query(
        `INSERT INTO knowledge.documents (topic_id, content, embedding, embedding_model)
         VALUES ($1, $2, $3::vector, $4)
         ON CONFLICT (topic_id) DO UPDATE
         SET content = EXCLUDED.content,
             embedding = EXCLUDED.embedding,
             embedding_model = EXCLUDED.embedding_model,
             updated_at = now()`,
        [topic.id, topic.content, vectorLiteral(embedding), EMBEDDING_MODEL]
      );
    }
    process.stdout.write(`Seeded ${knowledge.topics.length} verified local knowledge topics.\n`);
  } finally {
    await pool.end();
  }
}

seedKnowledge().catch((error: unknown) => {
  process.stderr.write(`Knowledge seed failed: ${String(error)}\n`);
  process.exitCode = 1;
});
