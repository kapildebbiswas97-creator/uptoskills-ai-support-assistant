import test from 'node:test';
import assert from 'node:assert/strict';
import { createGenerationConfig, GEMINI_MODEL, GEMINI_SYSTEM_INSTRUCTION, streamGeminiText } from './gemini';
import { generateAssistantReply } from '../src/utils/assistantEngine';
import { AudienceContext } from '../src/types/assistant';

test('Gemini uses the documented stable default model and exposes no function tools', () => {
  const config = createGenerationConfig(new AbortController().signal);
  const researchConfig = createGenerationConfig(new AbortController().signal, true);

  assert.equal(GEMINI_MODEL, process.env.GEMINI_MODEL || 'gemini-3.8-flash');
  assert.equal(config.tools, undefined);
  assert.equal(config.responseSchema, undefined);
  assert.deepEqual(researchConfig.tools, [{ googleSearch: {} }]);
  assert.match(GEMINI_SYSTEM_INSTRUCTION, /Never mark or edit attendance/);
  assert.match(GEMINI_SYSTEM_INSTRUCTION, /audience selector is an unverified display preference/);
});

test('Gemini enables web search for research and passes PDFs as inline document data', async () => {
  let request: Record<string, unknown> | undefined;
  const mockClient = {
    models: {
      generateContentStream: async (input: Record<string, unknown>) => {
        request = input;
        return (async function* () {
          yield {
            text: 'Here is the current summary.',
            candidates: [{ groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.com/source', title: 'Research Source' } }] } }],
          };
        })();
      },
    },
  } as unknown as Parameters<typeof streamGeminiText>[6];
  const guidance = generateAssistantReply('hi', AudienceContext.General);
  const attachment = { name: 'brief.pdf', mimeType: 'application/pdf' as const, data: 'JVBERi0xLjQ=' };
  const chunks: string[] = [];

  for await (const chunk of streamGeminiText(
    'Research the latest support chatbot patterns', guidance, new AbortController().signal,
    [], [], attachment, mockClient
  )) chunks.push(chunk);

  assert.deepEqual((request?.config as { tools?: unknown }).tools, [{ googleSearch: {} }]);
  assert.match(JSON.stringify(request?.contents), /application\/pdf/);
  assert.match(JSON.stringify(request?.contents), /JVBERi0xLjQ=/);
  assert.match(chunks.join(''), /Sources:\n- Research Source: https:\/\/example\.com\/source/);
});

test('Gemini SDK request uses grounded prompt settings and forwards streamed text', async () => {
  let request: Record<string, unknown> | undefined;
  const mockClient = {
    models: {
      generateContentStream: async (input: Record<string, unknown>) => {
        request = input;
        return (async function* () {
          yield { text: 'first ' };
          yield { text: 'second' };
        })();
      },
    },
  } as unknown as Parameters<typeof streamGeminiText>[6];
  const guidance = generateAssistantReply('Where can I find internships?', AudienceContext.General);
  const signal = new AbortController().signal;
  const chunks: string[] = [];

  for await (const chunk of streamGeminiText('Where can I find internships?', guidance, signal, [], [{ role: 'user', content: 'Hello' }], undefined, mockClient)) {
    chunks.push(chunk);
  }

  assert.deepEqual(chunks, ['first ', 'second']);
  assert.equal(request?.model, GEMINI_MODEL);
  assert.equal(request?.config && (request.config as { abortSignal?: AbortSignal }).abortSignal, signal);
  assert.match(String(request?.contents), /Verified local guidance/);
  assert.match(String(request?.contents), /User question/);
  assert.match(String(request?.contents), /user: Hello/);
  assert.equal((request?.config as { tools?: unknown }).tools, undefined);
});
