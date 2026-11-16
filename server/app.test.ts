import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { createApp, TextStream } from './app';
import { loadKnowledge } from './assistant';
import type { KnowledgeSearch } from './database';
import type { RequestRateLimiter } from './rate-limit';
import { clearFreeModelCatalogCacheForTests } from './model-catalog';

function makeTestPdf(text: string): Buffer {
  const escaped = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = `BT /F1 12 Tf 40 760 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let document = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(document));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(document);
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  document += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(document, 'binary');
}

async function withServer(
  run: (baseUrl: string) => Promise<void>,
  textStream?: TextStream,
  knowledgeSearch?: KnowledgeSearch,
  rateLimiter?: RequestRateLimiter,
  options: { requireChatAuthentication?: boolean } = {}
) {
  const app = createApp(await loadKnowledge(), textStream, knowledgeSearch, rateLimiter, undefined, undefined, undefined, options);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

test('staging chat and model routes deny anonymous requests before using providers or retrieval', async () => {
  let providerCalls = 0;
  let retrievalCalls = 0;
  const textStream: TextStream = async function* () { providerCalls += 1; yield 'must not run'; };
  const knowledgeSearch: KnowledgeSearch = async () => { retrievalCalls += 1; return ['private context']; };
  await withServer(async (baseUrl) => {
    const modelResponse = await fetch(`${baseUrl}/api/models`);
    const chatResponse = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'Hello' }),
    });
    const streamResponse = await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'Hello' }),
    });
    assert.equal(modelResponse.status, 401);
    assert.equal(chatResponse.status, 401);
    assert.equal(streamResponse.status, 401);
    assert.equal(providerCalls, 0);
    assert.equal(retrievalCalls, 0);
  }, textStream, knowledgeSearch, undefined, { requireChatAuthentication: true });
});

test('Express health and chat routes return local knowledge guidance', async () => {
  await withServer(async (baseUrl) => {
    const health = await fetch(`${baseUrl}/api/health`, { headers: { traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01' } });
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('x-trace-id'), '0123456789abcdef0123456789abcdef');
    assert.deepEqual(await health.json(), {
      status: 'ok', knowledgeVersion: 1, vectorSearch: false, rateLimit: 'none', modelAvailable: false,
      pdfDocuments: 0, pdfChunks: 0,
    });

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'How does attendance work?', audience: 'Captain / Team Lead' }),
    });
    const answer = await response.json();
    assert.equal(response.status, 200);
    assert.equal(answer.topicId, 'attendance');
    assert.match(answer.content, /intern.*read-only/i);
  });
});

test('health does not report model or vector search available without configured dependencies', async () => {
  const providerVariables = [
    'AI_PROVIDER', 'AI_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
    'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CEREBRAS_API_KEY', 'NVIDIA_API_KEY', 'MISTRAL_API_KEY', 'REQUESTY_API_KEY',
  ] as const;
  const previous = new Map(providerVariables.map((name) => [name, process.env[name]]));
  for (const name of providerVariables) delete process.env[name];
  const textStream: TextStream = async function* () { yield 'unused'; };
  const knowledgeSearch: KnowledgeSearch = async () => [];
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/health`);
      const body = await response.json();
      assert.equal(body.modelAvailable, false);
      assert.equal(body.vectorSearch, false);
    }, textStream, knowledgeSearch);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('model picker hides provider models until a provider key is configured', async () => {
  clearFreeModelCatalogCacheForTests();
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/models`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(payload.models, []);
    assert.equal(payload.defaultModel, '');
    assert.equal(payload.catalog, 'unconfigured');
    assert.equal(payload.modelAvailable, false);
  });
  clearFreeModelCatalogCacheForTests();
});

test('non-streaming /api/chat uses the model and hides the internal HR marker', async () => {
  let retrieved: string[] = [];
  let chosenModel = '';
  const textStream: TextStream = async function* (_query, _guidance, _signal, knowledge, _history, _attachment, model) {
    retrieved = knowledge;
    chosenModel = model ?? '';
    yield 'I could not verify that rule. [SHOW_HR_BUTTON]';
  };
  const knowledgeSearch: KnowledgeSearch = async () => ['[Source: policy.pdf]\nVerified policy excerpt'];
  const expectedModel = `${process.env.AI_PROVIDER || 'openrouter'}::${process.env.AI_MODEL || 'openrouter/free'}`;
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'What does the policy say?', model: process.env.AI_MODEL || 'openrouter/free' }),
    });
    const answer = await response.json();
    assert.equal(response.status, 200);
    assert.equal(answer.content, 'I could not verify that rule.');
    assert.equal(answer.suggestEscalation, true);
    assert.equal(answer.source, 'model');
    assert.equal(chosenModel, expectedModel);
    assert.ok(retrieved.some((item) => item.includes('policy.pdf')));
  }, textStream, knowledgeSearch);
});

test('Express chat route rejects empty and oversized messages', async () => {
  await withServer(async (baseUrl) => {
    const empty = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '' }),
    });
    assert.equal(empty.status, 400);

    const oversized = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'x'.repeat(2001) }),
    });
    assert.equal(oversized.status, 400);
  });
});

test('Express sanitizes malformed JSON parser errors', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"message":',
    });
    const body = await response.text();
    assert.equal(response.status, 400);
    assert.match(body, /Invalid request body/);
    assert.doesNotMatch(body, /SyntaxError|stack/i);
  });
});

test('Express stream route sends deltas and final local guidance metadata', async () => {
  let retrieved: string[] = [];
  const textStream: TextStream = async function* (_query, _guidance, _signal, knowledge) {
    retrieved = knowledge;
    yield 'Streamed ';
    yield 'answer.';
  };
  const knowledgeSearch: KnowledgeSearch = async () => ['Verified vector record'];

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ message: 'How does attendance work?' }),
    });
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.match(body, /event: delta/);
    assert.match(body, /Streamed answer\./);
    assert.match(body, /event: complete/);
    assert.match(body, /"topicId":"attendance"/);
    assert.equal(retrieved[0].startsWith('[Source: verified knowledge.yaml topic attendance]'), true);
    assert.equal(retrieved.at(-1), 'Verified vector record');
  }, textStream, knowledgeSearch);
});

test('Express buffers streamed output until security review blocks secrets and malicious URLs', async () => {
  let generationFinished = false;
  const textStream: TextStream = async function* () {
    yield 'Partial answer that must stay buffered. ';
    await new Promise((resolve) => setTimeout(resolve, 100));
    yield 'API key: sk-abcdefghijklmnop123456 https://attacker.example/collect';
    generationFinished = true;
  };

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ message: 'What is the leave policy?' }),
    });
    const reader = response.body!.getReader();
    const firstRead = reader.read();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(generationFinished, false);
    const first = await firstRead;
    assert.equal(generationFinished, true);
    let body = new TextDecoder().decode(first.value);
    while (!first.done) {
      const next = await reader.read();
      body += new TextDecoder().decode(next.value);
      if (next.done) break;
    }
    assert.match(body, /may expose sensitive information/);
    assert.doesNotMatch(body, /sk-abcdefghijklmnop|attacker\.example|Partial answer/);
    assert.match(body, /event: complete/);
  }, textStream);
});

test('Express bounds a hung provider stream and returns a timeout event', async () => {
  const priorTimeout = process.env.CHAT_TIMEOUT_MS;
  process.env.CHAT_TIMEOUT_MS = '1000';
  const textStream: TextStream = async function* () {
    await new Promise(() => undefined);
    yield 'never';
  };
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/chat/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ message: 'What is the leave policy?' }),
      });
      const body = await response.text();
      assert.match(body, /event: error/);
      assert.match(body, /timed out/);
      assert.doesNotMatch(body, /event: delta/);
    }, textStream);
  } finally {
    if (priorTimeout === undefined) delete process.env.CHAT_TIMEOUT_MS;
    else process.env.CHAT_TIMEOUT_MS = priorTimeout;
  }
});

test('Express aborts provider generation when the streaming client disconnects', async () => {
  let observedAbort = false;
  const textStream: TextStream = async function* (_query, _guidance, signal) {
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => { observedAbort = true; resolve(); }, { once: true }));
    return;
  };
  await withServer(async (baseUrl) => {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ message: 'What is the leave policy?' }),
      signal: controller.signal,
    });
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(observedAbort, true);
  }, textStream);
});

test('Express hides the model HR marker and exposes escalation metadata', async () => {
  const textStream: TextStream = async function* () {
    yield 'Please contact our support team. [SHOW_HR_';
    yield 'BUTTON]';
  };
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ message: 'What is the official policy on a new topic?' }),
    });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.doesNotMatch(body, /SHOW_HR_BUTTON/);
    assert.match(body, /"suggestEscalation":true/);
    assert.match(body, /Please contact our support team\./);
  }, textStream);
});

test('Express validates PDFs and forwards a valid attachment with chat history', async () => {
  const pdfData = makeTestPdf('This PDF is valid for checking the attachment flow.').toString('base64');
  let attachmentName = '';
  let priorTurns: string[] = [];
  const textStream: TextStream = async function* (_query, _guidance, _signal, _knowledge, history, attachment) {
    attachmentName = attachment?.name ?? '';
    priorTurns = history.map((turn) => turn.content);
    yield 'I reviewed the document.';
  };

  await withServer(async (baseUrl) => {
    const invalid = await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Analyze', attachment: { name: 'bad.pdf', mimeType: 'application/pdf', data: 'not-base64' } }),
    });
    assert.equal(invalid.status, 400);

    const valid = await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({
        message: 'Summarize this file',
        history: [{ role: 'user', content: 'I need a summary.' }],
        attachment: { name: 'guide.pdf', mimeType: 'application/pdf', data: pdfData },
      }),
    });
    assert.equal(valid.status, 200);
    assert.match(await valid.text(), /I reviewed the document/);
    assert.equal(attachmentName, 'guide.pdf');
    assert.deepEqual(priorTurns, ['I need a summary.']);
  }, textStream);
});

test('PDF analysis explains that AI provider setup is required in local-only mode', async () => {
  const pdfData = Buffer.from('%PDF-1.4\nexample').toString('base64');
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'Summarize this file',
        attachment: { name: 'guide.pdf', mimeType: 'application/pdf', data: pdfData },
      }),
    });
    assert.equal(response.status, 503);
    assert.match(await response.text(), /provider API key/);
  });
});

test('general coding and research requests explain how to enable the model', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Help me debug this Python code' }),
    });
    assert.equal(response.status, 503);
    assert.match(await response.text(), /provider API key/);
  });
});

test('Express applies the configured request limiter', async () => {
  const limiter: RequestRateLimiter = {
    backend: 'memory',
    allow: async () => false,
    close: async () => undefined,
  };
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'How do I contact support?' }),
    });
    assert.equal(response.status, 429);
  }, undefined, undefined, limiter);
});

test('Express rejects unconfigured model selection with clear provider key message', async () => {
  const textStream: TextStream = async function* () { yield 'ok'; };
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Hello', model: 'openrouter::google/gemma-4-31b-it:free' }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /provider for model.*is not configured.*OPENROUTER_API_KEY/i);
  }, textStream);
});

test('Express /api/models exposes models only when provider is configured and shows Gemini when configured', async () => {
  clearFreeModelCatalogCacheForTests();
  const priorGeminiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('googleapis.com')) {
      return new Response(JSON.stringify({
        data: [
          { id: 'models/gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
          { id: 'models/gemma-2-9b-it', name: 'Gemma 2 9B' },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return originalFetch(input);
  }) as typeof fetch;

  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/models`);
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.modelAvailable, true);
      assert.ok(data.models.some((m: { id: string }) => m.id === 'gemini::gemini-2.5-flash'));
      assert.ok(data.models.some((m: { id: string }) => m.id === 'gemini::gemma-2-9b-it'));
      // OpenRouter models should NOT appear because OPENROUTER_API_KEY is not configured
      assert.ok(!data.models.some((m: { id: string }) => m.id.startsWith('openrouter::')));
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (priorGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = priorGeminiKey;
    clearFreeModelCatalogCacheForTests();
  }
});
