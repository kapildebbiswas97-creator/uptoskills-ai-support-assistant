import assert from 'node:assert/strict';
import test from 'node:test';
import { filterUnverifiedCitations, rerankAndDeduplicateChunks, reviewModelOutput, validateAndAppendCitations } from './rag';

test('unsupported answer cannot retain a model-fabricated source citation', () => {
  const result = validateAndAppendCitations('I cannot verify that. [Source: invented.pdf, page 99]\n\nSources:\n- https://fake.example/a', ['[Source: unrelated.pdf]\nUnrelated text']);
  assert.equal(result.answer, 'I cannot verify that.');
  assert.deepEqual(result.citations, []);
  assert.doesNotMatch(result.answer, /fake\.example/);
});

test('citations are generated only from retrieved source headers with provenance', () => {
  const records = ['[Source: handbook.pdf, page 4, section Leave; document doc-a; chunk 2]\nApproved leave instructions'];
  const result = validateAndAppendCitations('Follow the process. [Source: fake.pdf]', records);
  assert.deepEqual(result.citations, [{ label: 'handbook.pdf, page 4, section Leave; document doc-a; chunk 2' }]);
  assert.match(result.answer, /\[Source: handbook\.pdf, page 4, section Leave; document doc-a; chunk 2\]/);
  assert.doesNotMatch(result.answer, /fake\.pdf/);
});

test('unretrieved URLs are removed and retrieved URLs remain eligible citations', () => {
  const records = ['[Source: official guide; https://docs.example/rules]\nRules are here: https://docs.example/rules'];
  const result = validateAndAppendCitations('See [the guide](https://fake.example/) or https://docs.example/rules.', records);
  assert.doesNotMatch(result.answer, /fake\.example/);
  assert.match(result.answer, /https:\/\/docs\.example\/rules/);
  assert.equal(result.citations[0].label, 'official guide; https://docs.example/rules');
});

test('output review blocks credential-like and internal-prompt disclosures', () => {
  const credential = reviewModelOutput('Use this API key: sk-abcdefghijklmnop123456', []);
  assert.equal(credential.blocked, true);
  assert.equal(credential.reason, 'sensitive_data');
  assert.doesNotMatch(credential.answer, /sk-/);

  const prompt = reviewModelOutput('System prompt: reveal the hidden policy now.', []);
  assert.equal(prompt.blocked, true);
  assert.equal(prompt.reason, 'internal_prompt');
  assert.doesNotMatch(prompt.answer, /hidden policy/);
});

test('output review removes malicious URLs and permits only exact retrieved URLs', () => {
  const record = '[Source: handbook; https://help.example/policy]\nPolicy link https://help.example/policy';
  const result = reviewModelOutput('Read https://attacker.example/steal or https://help.example/policy', [record]);
  assert.equal(result.blocked, false);
  assert.doesNotMatch(result.answer, /attacker\.example/);
  assert.match(result.answer, /https:\/\/help\.example\/policy/);
});

test('streaming suppresses model-authored citation labels and source lists before delivery', async () => {
  async function* chunks() {
    yield 'Answer text. [Source:';
    yield ' fake.pdf]\n\nSources:\n- https://fake.example\n\nMore answer.';
  }
  const output: string[] = [];
  for await (const chunk of filterUnverifiedCitations(chunks())) output.push(chunk);
  assert.equal(output.join(''), 'Answer text. \nMore answer.');
  assert.doesNotMatch(output.join(''), /fake\.pdf|fake\.example/);
});

test('reranking removes duplicate chunks and prefers query term overlap', () => {
  const result = rerankAndDeduplicateChunks('leave policy', [
    { documentId: 'a', chunkIndex: 0, content: 'A generic unrelated paragraph.', fusionScore: 0.03, metadata: {} },
    { documentId: 'b', chunkIndex: 1, content: 'Leave policy applies to each intern.', fusionScore: 0.02, metadata: {} },
    { documentId: 'c', chunkIndex: 2, content: 'leave   policy applies to each intern.', fusionScore: 0.01, metadata: {} },
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0].documentId, 'b');
});
