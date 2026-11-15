import 'dotenv/config';
import { getMongoDatabase, initializeMongoSchema, closeMongoForTests } from './mongodb';

try {
  const db = await getMongoDatabase();
  await initializeMongoSchema(db);
  process.stdout.write('MongoDB collections and indexes are ready.\n');
} catch (error) {
  process.stderr.write(`MongoDB initialization failed: ${error instanceof Error ? error.message : 'database error'}\n`);
  process.exitCode = 1;
} finally {
  await closeMongoForTests();
}
