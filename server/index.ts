import 'dotenv/config';
import { createApp, type TextStream } from './app';
import { loadKnowledge } from './assistant';
import { getAIProviderConfig, getConfiguredAIProviders, streamOpenAICompatible, splitNamespacedModel } from './ai-provider';
import { streamGeminiText } from './gemini';
import { createPdfKnowledgeBase } from './knowledge-base';
import { createRequestRateLimiter } from './rate-limit';

const port = Number(process.env.PORT ?? 3001);

async function start() {
  const knowledge = await loadKnowledge();
  const pdfKnowledgeBase = createPdfKnowledgeBase();
  await pdfKnowledgeBase.rebuild();
  const stopWatchingPdfs = pdfKnowledgeBase.watchForChanges((documents, chunks) => {
    process.stdout.write(`PDF knowledge refreshed: ${documents} documents, ${chunks} chunks\n`);
  });
  const aiConfig = getAIProviderConfig();
  const configuredAIProviders = getConfiguredAIProviders();
  const rateLimiter = await createRequestRateLimiter(process.env.REDIS_URL);

  const streamAI: TextStream = async function* (
    query,
    verifiedGuidance,
    abortSignal,
    retrievedKnowledge,
    history,
    attachment,
    selectedModel
  ) {
    const namespaced = selectedModel ? splitNamespacedModel(selectedModel) : undefined;
    const provider = namespaced?.provider ?? (configuredAIProviders[0]?.provider || 'openrouter');
    if (provider === 'gemini') {
      yield* streamGeminiText(
        query,
        verifiedGuidance,
        abortSignal,
        retrievedKnowledge,
        history,
        attachment,
        undefined,
        namespaced?.model
      );
    } else {
      yield* streamOpenAICompatible(
        query,
        verifiedGuidance,
        abortSignal,
        retrievedKnowledge,
        history,
        attachment,
        selectedModel
      );
    }
  };

  const app = createApp(
    knowledge,
    configuredAIProviders.length ? streamAI : undefined,
    undefined,
    rateLimiter,
    pdfKnowledgeBase
  );

  const server = app.listen(port, '127.0.0.1', () => {
    process.stdout.write(`UpToSkills support API listening on http://127.0.0.1:${port}\n`);
    process.stdout.write(`AI provider options: ${configuredAIProviders.length ? configuredAIProviders.map(({ providerLabel }) => providerLabel).join(', ') : 'none configured'}; default: ${aiConfig.providerLabel} / ${aiConfig.model}\n`);
    process.stdout.write(`PDF knowledge: ${pdfKnowledgeBase.documentCount} documents, ${pdfKnowledgeBase.chunkCount} chunks from ${pdfKnowledgeBase.documentsDirectory}\n`);
  });

  const shutdown = () => {
    server.close(async () => {
      await stopWatchingPdfs();
      await rateLimiter.close();
      process.exit(0);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

start().catch((error: unknown) => {
  process.stderr.write(`Unable to start support API: ${String(error)}\n`);
  process.exitCode = 1;
});
