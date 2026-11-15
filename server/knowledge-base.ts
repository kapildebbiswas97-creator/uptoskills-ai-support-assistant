import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const CHUNK_SIZE = 1400;
const CHUNK_OVERLAP = 220;
const INDEXED_EXTENSIONS = new Set(['.pdf', '.md', '.txt']);
const TOKEN_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu;

interface KnowledgeChunk {
  source: string;
  index: number;
  text: string;
  termCounts: Map<string, number>;
  length: number;
}

export interface PdfKnowledgeBase {
  readonly documentsDirectory: string;
  readonly documentCount: number;
  readonly chunkCount: number;
  rebuild(): Promise<void>;
  search(query: string, limit?: number): string[];
  watchForChanges(onUpdate?: (documentCount: number, chunkCount: number) => void): () => Promise<void>;
}

export class PdfProcessingUnavailableError extends Error {
  constructor() {
    super('PDF_PROCESSING_UNAVAILABLE');
    this.name = 'PdfProcessingUnavailableError';
  }
}

function tokenize(value: string): string[] {
  return value.toLocaleLowerCase().match(TOKEN_PATTERN) ?? [];
}

export function splitIntoChunks(text: string): string[] {
  const normalized = text.replace(/\r/g, '').replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + CHUNK_SIZE, normalized.length);
    if (end < normalized.length) {
      const preferredBreak = normalized.lastIndexOf('\n', end);
      const sentenceBreak = normalized.lastIndexOf('. ', end);
      const breakAt = Math.max(preferredBreak, sentenceBreak);
      if (breakAt > start + CHUNK_SIZE * 0.55) end = breakAt + 1;
    }
    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;
    start = Math.max(start + 1, end - CHUNK_OVERLAP);
  }
  return chunks;
}

export async function extractPdfText(data: Uint8Array): Promise<string> {
  let parser: InstanceType<(typeof import('pdf-parse'))['PDFParse']>;
  try {
    // pdf-parse/worker loads the real native CanvasFactory and its platform
    // binary. Keep both imports lazy so Node initializes PDF.js only when a
    // PDF is actually processed, never while the serverless handler starts.
    const { CanvasFactory } = await import('pdf-parse/worker');
    const { PDFParse } = await import('pdf-parse');
    parser = new PDFParse({ data, CanvasFactory });
  } catch {
    throw new PdfProcessingUnavailableError();
  }
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

async function extractDocumentText(filePath: string, data: Uint8Array): Promise<string> {
  if (path.extname(filePath).toLocaleLowerCase() !== '.pdf') return Buffer.from(data).toString('utf8');
  return extractPdfText(data);
}

function isIndexedDocument(name: string): boolean {
  return INDEXED_EXTENSIONS.has(path.extname(name).toLocaleLowerCase()) && !/^readme(?:\.|$)/i.test(name);
}

export function createPdfKnowledgeBase(documentsDirectory = path.resolve(process.cwd(), 'docs')): PdfKnowledgeBase {
  let chunks: KnowledgeChunk[] = [];
  let documentCount = 0;
  let rebuilding: Promise<void> | undefined;

  const rebuild = async () => {
    if (rebuilding) return rebuilding;
    rebuilding = (async () => {
      await mkdir(documentsDirectory, { recursive: true });
      const names = (await readdir(documentsDirectory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && isIndexedDocument(entry.name))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
      const nextChunks: KnowledgeChunk[] = [];
      let parsedDocuments = 0;

      for (const name of names) {
        try {
          const bytes = await readFile(path.join(documentsDirectory, name));
          const isPdf = path.extname(name).toLocaleLowerCase() === '.pdf';
          if (bytes.length < 8 || bytes.length > 50 * 1024 * 1024 || (isPdf && bytes.subarray(0, 5).toString('ascii') !== '%PDF-')) {
            process.stderr.write(`Skipping invalid or oversized knowledge document in docs/: ${name}\n`);
            continue;
          }
          const text = await extractDocumentText(name, bytes);
          const parts = splitIntoChunks(text);
          if (!parts.length) {
            process.stderr.write(`Skipping knowledge document with no extractable text in docs/: ${name}\n`);
            continue;
          }
          parsedDocuments += 1;
          parts.forEach((part, index) => {
            const tokens = tokenize(part);
            const termCounts = new Map<string, number>();
            for (const token of tokens) termCounts.set(token, (termCounts.get(token) ?? 0) + 1);
            nextChunks.push({ source: name, index: index + 1, text: part, termCounts, length: tokens.length });
          });
        } catch (error) {
          const reason = error instanceof PdfProcessingUnavailableError
            ? error.message
            : error instanceof Error
              ? error.name
              : 'UNKNOWN_PDF_ERROR';
          process.stderr.write(`Could not index knowledge document ${name}: ${reason}\n`);
        }
      }

      chunks = nextChunks;
      documentCount = parsedDocuments;
    })().finally(() => {
      rebuilding = undefined;
    });
    return rebuilding;
  };

  return {
    documentsDirectory,
    get documentCount() { return documentCount; },
    get chunkCount() { return chunks.length; },
    rebuild,
    search(query, limit = 4) {
      const queryTerms = [...new Set(tokenize(query))];
      if (!queryTerms.length || !chunks.length) return [];
      const averageLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0) / chunks.length || 1;
      const documentFrequency = new Map<string, number>();
      for (const term of queryTerms) {
        documentFrequency.set(term, chunks.reduce((count, chunk) => count + Number(chunk.termCounts.has(term)), 0));
      }

      const scored = chunks.map((chunk) => {
        let score = 0;
        for (const term of queryTerms) {
          const frequency = chunk.termCounts.get(term) ?? 0;
          if (!frequency) continue;
          const df = documentFrequency.get(term) ?? 0;
          const idf = Math.log(1 + (chunks.length - df + 0.5) / (df + 0.5));
          const denominator = frequency + 1.2 * (1 - 0.75 + 0.75 * chunk.length / averageLength);
          score += idf * (frequency * 2.2) / denominator;
        }
        return { chunk, score };
      }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score);

      const results: string[] = [];
      const perSource = new Map<string, number>();
      for (const { chunk } of scored) {
        if ((perSource.get(chunk.source) ?? 0) >= 2) continue;
        perSource.set(chunk.source, (perSource.get(chunk.source) ?? 0) + 1);
        results.push(`[Source: ${chunk.source}, chunk ${chunk.index}]\n${chunk.text}`);
        if (results.length >= Math.max(1, Math.min(limit, 4))) break;
      }
      return results;
    },
    watchForChanges(onUpdate) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stopped = false;
      let checking = false;
      let previousSignature: string | undefined;
      const getSignature = async () => {
        const files = (await readdir(documentsDirectory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && isIndexedDocument(entry.name))
          .map((entry) => entry.name)
          .sort((a, b) => a.localeCompare(b));
        const details = await Promise.all(files.map(async (name) => {
          const info = await stat(path.join(documentsDirectory, name));
          return `${name}:${info.size}:${info.mtimeMs}`;
        }));
        return details.join('|');
      };
      const checkForChanges = async () => {
        if (stopped || checking) return;
        checking = true;
        try {
          const signature = await getSignature();
          if (previousSignature === undefined) {
            previousSignature = signature;
          } else if (signature !== previousSignature) {
            previousSignature = signature;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
              void rebuild().then(() => onUpdate?.(documentCount, chunks.length));
            }, 350);
          }
        } catch (error) {
          process.stderr.write(`Could not check docs/: ${error instanceof Error ? error.message : 'directory scan error'}\n`);
        } finally {
          checking = false;
        }
      };
      void mkdir(documentsDirectory, { recursive: true }).then(checkForChanges);
      const interval = setInterval(() => void checkForChanges(), 1000);
      return async () => {
        stopped = true;
        clearInterval(interval);
        if (timer) clearTimeout(timer);
      };
    },
  };
}
