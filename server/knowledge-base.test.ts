import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPdfKnowledgeBase, extractPdfText, splitIntoChunks } from './knowledge-base';

function makeTextPdf(text: string): Buffer {
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

test('PDF knowledge base extracts local PDFs, retrieves relevant overlapping chunks, and rebuilds on updates', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'uts-pdf-kb-'));
  try {
    const docs = path.join(directory, 'docs');
    await mkdir(docs);
    const original = makeTextPdf('UpToSkills onboarding requires a verified offer letter and identity document. Contact the onboarding team for access instructions.');
    assert.match(await extractPdfText(original), /verified offer letter/);
    await writeFile(path.join(docs, 'onboarding.pdf'), original);

    const knowledge = createPdfKnowledgeBase(docs);
    await knowledge.rebuild();
    assert.equal(knowledge.documentCount, 1);
    assert.equal(knowledge.chunkCount, 1);
    assert.match(knowledge.search('What onboarding identity document is needed?')[0], /onboarding\.pdf/);
    assert.match(knowledge.search('What onboarding identity document is needed?')[0], /identity document/);

    await writeFile(path.join(docs, 'faq.pdf'), makeTextPdf('A cohort attendance report is submitted each Friday to the assigned team lead.'));
    await knowledge.rebuild();
    assert.equal(knowledge.documentCount, 2);
    assert.match(knowledge.search('How often is the attendance report submitted?')[0], /faq\.pdf/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('PDF extraction remains available when the parser runtime is supported', async () => {
  const text = await extractPdfText(makeTextPdf('Supported PDF parsing extracts this searchable text.'));
  assert.match(text, /Supported PDF parsing extracts this searchable text/);
});

test('PDF parser dependency failure is controlled and does not abort knowledge-base rebuild', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'uts-pdf-unavailable-'));
  const attemptedImports: string[] = [];
  const importGuard = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'pdf-parse/worker' || specifier === 'pdf-parse') {
        attemptedImports.push(specifier);
        throw new Error('simulated unavailable PDF runtime dependency');
      }
      return nextResolve(specifier, context);
    },
  });
  try {
    const pdf = makeTextPdf('This PDF cannot be indexed when its runtime dependency is unavailable.');
    await assert.rejects(extractPdfText(pdf), {
      name: 'PdfProcessingUnavailableError',
      message: 'PDF_PROCESSING_UNAVAILABLE',
    });

    const docs = path.join(directory, 'docs');
    await mkdir(docs);
    await writeFile(path.join(docs, 'local-reference.pdf'), pdf);
    const knowledge = createPdfKnowledgeBase(docs);
    await assert.doesNotReject(knowledge.rebuild());
    assert.equal(knowledge.documentCount, 0);
    assert.deepEqual(knowledge.search('runtime dependency'), []);
    assert.ok(attemptedImports.includes('pdf-parse/worker'));
  } finally {
    importGuard.deregister();
    await rm(directory, { recursive: true, force: true });
  }
});

test('PDF text chunking preserves an overlap and handles long documents', () => {
  const text = 'verified onboarding policy '.repeat(180);
  const chunks = splitIntoChunks(text);
  assert.ok(chunks.length > 1);
  assert.ok(chunks[1].startsWith(chunks[0].slice(-219)));
  assert.ok(chunks.every((chunk) => chunk.length <= 1400));
});

test('knowledge base retrieves permanently bundled Markdown references and skips folder READMEs', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'uts-md-kb-'));
  try {
    await writeFile(path.join(directory, 'README.md'), 'Do not index this setup text.');
    await writeFile(path.join(directory, 'uptoskills-brand-reference.md'), [
      '---',
      'source: https://github.com/UptoSkills-com/BrandKit',
      '---',
      '# UptoSkills brand voice',
      'The UptoSkills public brand guide calls for clear and approachable communication for students and freshers.',
    ].join('\n'));
    const knowledge = createPdfKnowledgeBase(directory);
    await knowledge.rebuild();
    assert.equal(knowledge.documentCount, 1);
    assert.match(knowledge.search('What tone should the assistant use for students?')[0], /uptoskills-brand-reference\.md/);
    assert.match(knowledge.search('What tone should the assistant use for students?')[0], /clear and approachable/);
    assert.doesNotMatch(knowledge.search('setup text')[0] ?? '', /setup text/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('PDF directory watcher automatically refreshes the index after a file is added', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'uts-pdf-watch-'));
  const docs = path.join(directory, 'docs');
  try {
    await mkdir(docs);
    const knowledge = createPdfKnowledgeBase(docs);
    await knowledge.rebuild();
    let onUpdated: ((documentCount: number, chunkCount: number) => void) | undefined;
    const refreshed = new Promise<void>((resolve) => {
      onUpdated = (documentCount, chunkCount) => {
        if (documentCount === 1 && chunkCount > 0) resolve();
      };
    });
    const stopWatching = knowledge.watchForChanges((count, chunks) => onUpdated?.(count, chunks));
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await writeFile(path.join(docs, 'new-policy.pdf'), makeTextPdf('Verified onboarding instructions are listed in this updated PDF.'));
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          refreshed,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error('PDF watcher did not refresh')), 5000);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      assert.equal(knowledge.documentCount, 1);
      assert.match(knowledge.search('verified onboarding instructions')[0], /new-policy\.pdf/);
    } finally {
      await stopWatching();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
