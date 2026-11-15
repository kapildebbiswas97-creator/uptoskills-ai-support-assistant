export interface Citation {
  label: string;
}

const SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}\b/i,
  /\b(?:sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{35})\b/,
  /\b[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:api[_ -]?key|client[_ -]?secret|password|passwd)\s*[:=]\s*[^\s,;]{8,}/i,
  /\bpostgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@/i,
];

const INTERNAL_PROMPT_PATTERNS = [
  /\b(?:system|developer)\s+(?:prompt|instructions?)\s*[:=]/i,
  /<\|(?:system|developer)\|>/i,
  /\bignore\s+(?:all\s+)?previous\s+instructions\s+and\s+(?:reveal|print|repeat)/i,
];

export function reviewModelOutput(answer: string, records: string[]): { answer: string; blocked: boolean; reason?: 'sensitive_data' | 'internal_prompt' } {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(answer))) {
    return { answer: 'I can’t provide that response because it may expose sensitive information. Please rephrase your request or contact support.', blocked: true, reason: 'sensitive_data' };
  }
  if (INTERNAL_PROMPT_PATTERNS.some((pattern) => pattern.test(answer))) {
    return { answer: 'I can’t provide internal instructions. I can still help with your support question.', blocked: true, reason: 'internal_prompt' };
  }

  const allowedUrls = new Set<string>();
  for (const record of records) {
    for (const match of record.matchAll(/https?:\/\/[^\s)\]>"']+/gi)) allowedUrls.add(match[0].replace(/[.,;:!?]+$/, ''));
  }
  const reviewed = answer
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi, (full, label: string, url: string) =>
      allowedUrls.has(url.replace(/[.,;:!?]+$/, '')) ? full : label
    )
    .replace(/https?:\/\/[^\s)\]>"']+/gi, (url) =>
      allowedUrls.has(url.replace(/[.,;:!?]+$/, '')) ? url : ''
    );
  return { answer: reviewed, blocked: false };
}

export async function* filterUnverifiedCitations(chunks: AsyncIterable<string>): AsyncGenerator<string> {
  let buffer = '';
  let droppingSourceList = false;
  for await (const chunk of chunks) {
    buffer += chunk;
    while (buffer) {
      if (droppingSourceList) {
        const end = buffer.indexOf('\n\n');
        if (end < 0) {
          buffer = buffer.endsWith('\n') ? '\n' : '';
          break;
        }
        buffer = buffer.slice(end + 2);
        droppingSourceList = false;
        continue;
      }
      const sourceHeading = /(?:^|\n)[ \t]*(?:Sources|References):/i.exec(buffer);
      const sourceCitation = buffer.indexOf('[Source:');
      const headingIndex = sourceHeading?.index ?? -1;
      if (headingIndex >= 0 && (sourceCitation < 0 || headingIndex <= sourceCitation)) {
        const before = buffer.slice(0, headingIndex);
        if (before) yield before;
        buffer = buffer.slice(headingIndex + (buffer[headingIndex] === '\n' ? 1 : 0));
        droppingSourceList = true;
        continue;
      }
      if (sourceCitation >= 0) {
        const before = buffer.slice(0, sourceCitation);
        if (before) yield before;
        const close = buffer.indexOf(']', sourceCitation + 8);
        if (close < 0) {
          buffer = buffer.length - sourceCitation > 600 ? '' : buffer.slice(sourceCitation);
          break;
        }
        buffer = buffer.slice(close + 1);
        continue;
      }
      const markers = ['[Source:', 'Sources:', 'References:'];
      let keep = 0;
      for (let length = 1; length < Math.max(...markers.map((marker) => marker.length)); length += 1) {
        const suffix = buffer.slice(-length);
        if (markers.some((marker) => marker.toLowerCase().startsWith(suffix.toLowerCase()))) keep = length;
      }
      const safe = buffer.slice(0, buffer.length - keep);
      if (safe) yield safe;
      buffer = keep ? buffer.slice(-keep) : '';
      break;
    }
  }
  if (!droppingSourceList && buffer && !buffer.includes('[Source:')) yield buffer;
}

export function collectRetrievedCitations(records: string[]): Citation[] {
  const labels = new Set<string>();
  for (const record of records) {
    const label = /^\[Source:\s*([^\]\r\n]{1,500})\]\s*$/m.exec(record)?.[1]?.trim();
    if (label) labels.add(label);
  }
  return [...labels].map((label) => ({ label }));
}

export function validateAndAppendCitations(answer: string, records: string[]): { answer: string; citations: Citation[] } {
  const reviewed = reviewModelOutput(answer, records);
  answer = reviewed.answer;
  const abstains = reviewed.blocked || /\b(?:cannot|can't|could not|couldn't|unable to)\s+(?:verify|confirm|find|answer)|not enough information|not (?:in|available from) the (?:provided|available) (?:documents|sources)\b/i.test(answer);
  const citations = abstains ? [] : collectRetrievedCitations(records);
  const trustedUrls = new Set<string>();
  if (!abstains) {
    for (const record of records) {
      for (const match of record.matchAll(/https?:\/\/[^\s)\]>"']+/gi)) trustedUrls.add(match[0].replace(/[.,;:!?]+$/, ''));
    }
  }
  const lines: string[] = [];
  let skippingSourceList = false;
  for (const line of answer.split(/\r?\n/)) {
    if (/^\s*(?:sources|references):/i.test(line)) {
      skippingSourceList = true;
      continue;
    }
    if (skippingSourceList && (!line.trim() || /^\s*(?:[-*]|\d+[.)]|\[Source:|https?:\/\/)/i.test(line))) continue;
    skippingSourceList = false;
    lines.push(line);
  }
  const citationPattern = /\[Source:\s*[^\]]*\]/g;
  let validated = lines.join('\n').replace(citationPattern, '');
  validated = validated.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi, (full, label: string, url: string) =>
    trustedUrls.has(url.replace(/[.,;:!?]+$/, '')) ? full : label
  );
  validated = validated.replace(/https?:\/\/[^\s)\]>"']+/gi, (url) =>
    trustedUrls.has(url.replace(/[.,;:!?]+$/, '')) ? url : ''
  ).replace(/^\s*-\s*$/gm, '').trim();
  if (!citations.length) return { answer: validated, citations };
  const footer = `Sources:\n${citations.map(({ label }) => `- [Source: ${label}]`).join('\n')}`;
  return { answer: validated ? `${validated}\n\n${footer}` : footer, citations };
}

export interface RankedChunk {
  documentId: string;
  chunkIndex: number;
  content: string;
  fusionScore: number;
  metadata: Record<string, unknown>;
}

function terms(text: string): Set<string> {
  return new Set(text.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []);
}

export function rerankAndDeduplicateChunks(query: string, chunks: RankedChunk[], limit = 4): RankedChunk[] {
  const queryTerms = terms(query);
  const bestByContent = new Map<string, { chunk: RankedChunk; score: number }>();
  for (const chunk of chunks) {
    const normalized = chunk.content.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
    if (!normalized) continue;
    const chunkTerms = terms(normalized);
    const overlap = queryTerms.size ? [...queryTerms].filter((term) => chunkTerms.has(term)).length / queryTerms.size : 0;
    const score = Math.max(0, chunk.fusionScore) + overlap * 0.05;
    const prior = bestByContent.get(normalized);
    if (!prior || score > prior.score) bestByContent.set(normalized, { chunk, score });
  }
  return [...bestByContent.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(limit, 12)))
    .map(({ chunk }) => chunk);
}
