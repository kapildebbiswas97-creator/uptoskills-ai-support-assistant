import 'dotenv/config';
import { createDocumentService } from './document-ingestion';
import { closeMongoForTests } from './mongodb';

const service = createDocumentService();
try {
  if (!service) throw new Error('DATABASE_INGEST_URL is not configured');
  const result = await service.recoverPending(100);
  process.stdout.write(`Document reconciliation complete: ${result.recovered} recovered, ${result.failed} failed.\n`);
} catch (error) {
  process.stderr.write(`Document reconciliation failed: ${error instanceof Error ? error.message : 'database error'}\n`);
  process.exitCode = 1;
} finally {
  await service?.close();
  await closeMongoForTests();
}
