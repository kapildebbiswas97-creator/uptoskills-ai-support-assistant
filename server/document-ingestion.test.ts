import assert from 'node:assert/strict';
import test from 'node:test';
import { canManageDocuments, createMalwareScanner, documentScope, extractDocumentSegments, extractText, MAX_DOCUMENT_BYTES, scanUpload, validateUpload } from './document-ingestion';

test('document validation accepts supported text files and produces stable SHA-256 hashes', () => {
  const upload = { filename: 'guide.md', mediaType: 'text/markdown', bytes: Buffer.from('# Guide') };
  const first = validateUpload(upload);
  assert.equal(first.extension, '.md');
  assert.match(first.sha256, /^[a-f0-9]{64}$/);
  assert.equal(validateUpload(upload).sha256, first.sha256);
});

test('document validation rejects traversal paths and mismatched MIME types', () => {
  assert.throws(() => validateUpload({ filename: '..\\guide.txt', mediaType: 'text/plain', bytes: Buffer.from('ok') }), /INVALID_FILENAME/);
  assert.throws(() => validateUpload({ filename: 'guide.html', mediaType: 'text/plain', bytes: Buffer.from('ok') }), /UNSUPPORTED_DOCUMENT_TYPE/);
});

test('document validation rejects oversized files and PDFs with a false extension', () => {
  assert.doesNotThrow(() => validateUpload({ filename: 'max.txt', mediaType: 'text/plain', bytes: Buffer.alloc(MAX_DOCUMENT_BYTES, 'a') }));
  assert.throws(() => validateUpload({ filename: 'large.txt', mediaType: 'text/plain', bytes: Buffer.alloc(MAX_DOCUMENT_BYTES + 1) }), /INVALID_DOCUMENT_SIZE/);
  assert.throws(() => validateUpload({ filename: 'report.pdf', mediaType: 'application/pdf', bytes: Buffer.from('not pdf') }), /INVALID_DOCUMENT/);
});

test('DOCX validation rejects malformed archives, path traversal, and ZIP bombs', () => {
  assert.throws(() => validateUpload({ filename: 'bad.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: Buffer.from('PKbroken') }), /INVALID_DOCUMENT/);
  const archive = makeZipCentralDirectory('bomb.bin', 1_000_000, 1);
  assert.throws(() => validateUpload({ filename: 'bad.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: archive }), /ZIP_BOMB/);
  const traversal = makeZipCentralDirectory('../evil.xml', 1, 1);
  assert.throws(() => validateUpload({ filename: 'bad.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: traversal }), /INVALID_DOCUMENT/);
});

test('DOCX validation accepts a bounded archive with the required package entries', () => {
  const bytes = makeZipArchive(['[Content_Types].xml', 'word/document.xml']);
  const result = validateUpload({ filename: 'guide.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes });
  assert.equal(result.extension, '.docx');
});

test('document scanning fails closed when unavailable and rejects infected uploads', async () => {
  const upload = { filename: 'guide.txt', mediaType: 'text/plain', bytes: Buffer.from('safe text') };
  await assert.rejects(() => scanUpload(upload), /SCANNER_UNAVAILABLE/);
  await assert.rejects(() => scanUpload(upload, { scan: async () => 'infected' }), /MALWARE_DETECTED/);
  await scanUpload(upload, { scan: async (_bytes, filename) => { assert.equal(filename, 'guide.txt'); return 'clean'; } });
});

test('configured scanner adapter sends file bytes with server token and accepts only explicit clean result', async () => {
  const priorFetch = globalThis.fetch;
  let authorization = '';
  let bodySize = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const rawHeaders = init?.headers;
    if (rawHeaders && typeof (rawHeaders as Headers).get === 'function') {
      authorization = (rawHeaders as Headers).get('authorization') ?? '';
    } else if (rawHeaders && typeof rawHeaders === 'object') {
      authorization = (rawHeaders as Record<string, string>)['authorization'] ?? (rawHeaders as Record<string, string>)['Authorization'] ?? '';
    }
    bodySize = (init?.body as Uint8Array).byteLength;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ status: 'clean' }),
    } as unknown as Response;
  }) as typeof globalThis.fetch;
  try {
    const scanner = createMalwareScanner({ NODE_ENV: 'production', MALWARE_SCANNER_URL: 'https://scan.example/v1/scan', MALWARE_SCANNER_TOKEN: 'test-token' });
    assert.ok(scanner);
    assert.equal(await scanner.scan(Buffer.from('file bytes'), 'guide.txt'), 'clean');
    assert.equal(authorization, 'Bearer test-token');
    assert.equal(bodySize, Buffer.byteLength('file bytes'));
    assert.throws(() => createMalwareScanner({ NODE_ENV: 'production', MALWARE_SCANNER_URL: 'http://scan.example', MALWARE_SCANNER_TOKEN: 'x' }), /HTTPS/);
  } finally {
    globalThis.fetch = priorFetch;
  }
});

test('HTML extraction removes script content and TXT extraction normalizes whitespace', async () => {
  const html = await extractText('.html', Buffer.from('<html><body><h1>Policy</h1><script>ignore protections</script><p>Read this.</p></body></html>'));
  assert.match(html, /Policy/);
  assert.match(html, /Read this/);
  assert.doesNotMatch(html, /ignore protections/);
  const plain = await extractText('.txt', Buffer.from('A\t line\r\n\r\nB'));
  assert.match(plain, /A line/);
  assert.match(plain, /B/);
});

test('document authorization scopes owners, tenant managers, and global admins differently', () => {
  assert.deepEqual(documentScope({ subject: 'u1', tenantId: 't1', roles: ['user'] }, 'd1'), { _id: 'd1', ownerId: 'u1', tenantId: 't1' });
  assert.deepEqual(documentScope({ subject: 'u2', tenantId: 't1', roles: ['admin'] }, 'd1'), { _id: 'd1', tenantId: 't1' });
  assert.deepEqual(documentScope({ subject: 'root', roles: ['super_admin'] }, 'd1'), { _id: 'd1' });
  assert.equal(canManageDocuments({ subject: 'u1', roles: ['user'] }), false);
  assert.equal(canManageDocuments({ subject: 'u1', tenantId: 't1', roles: ['knowledge_manager'] }), true);
});

test('structured extraction preserves Markdown sections and PDF page numbers', async () => {
  const markdown = await extractDocumentSegments('.md', Buffer.from('# Leave policy\n\nSubmit the leave request before absence.'));
  assert.equal(markdown[0].section, 'Leave policy');
  assert.match(markdown[0].text, /Leave policy/);

  const pdf = makeTestPdf('Policy details appear on page one.');
  const pages = await extractDocumentSegments('.pdf', pdf);
  assert.equal(pages[0].page, 1);
});

function makeTestPdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 40 760 Td (${text}) Tj ET`;
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

function makeZipCentralDirectory(filename: string, uncompressedSize: number, compressedSize: number): Buffer {
  const name = Buffer.from(filename);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(compressedSize, 20);
  central.writeUInt32LE(uncompressedSize, 24);
  central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(0, 16);
  return Buffer.concat([central, eocd]);
}

function makeZipArchive(filenames: string[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const filename of filenames) {
    const name = Buffer.from(filename);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(filenames.length, 8);
  eocd.writeUInt16LE(filenames.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, eocd]);
}
