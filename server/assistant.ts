import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { AudienceContext, HelpTopicId } from '../src/types/assistant.js';
import { generateAssistantReply, type AssistantReplyResult } from '../src/utils/assistantEngine.js';

export interface KnowledgeTopic {
  id: string;
  topicId: HelpTopicId;
  keywords: string[];
  content: string;
}

export interface LocalKnowledge {
  version: number;
  topics: KnowledgeTopic[];
}

const KNOWLEDGE_PATH = fileURLToPath(new URL('../knowledge.yaml', import.meta.url));

export async function loadKnowledge(path = KNOWLEDGE_PATH): Promise<LocalKnowledge> {
  const source = await readFile(path, 'utf8');
  const parsed: unknown = parse(source);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('version' in parsed) ||
    !('topics' in parsed) ||
    typeof parsed.version !== 'number' ||
    !Array.isArray(parsed.topics)
  ) {
    throw new Error('knowledge.yaml must contain a version and topics array');
  }

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;
  const topics = parsed.topics as unknown[];
  if (
    topics.length === 0 ||
    topics.some((topic) =>
      !isRecord(topic) ||
      typeof topic.id !== 'string' ||
      !Object.values(HelpTopicId).includes(topic.topicId as HelpTopicId) ||
      !Array.isArray(topic.keywords) ||
      topic.keywords.some((keyword) => typeof keyword !== 'string') ||
      typeof topic.content !== 'string' ||
      !topic.content.trim()
    )
  ) {
    throw new Error('knowledge.yaml contains an invalid topic entry');
  }

  return { version: parsed.version, topics: topics as KnowledgeTopic[] };
}

function findTopic(query: string, topics: KnowledgeTopic[]): KnowledgeTopic | undefined {
  const normalized = query.toLocaleLowerCase();
  let best: { topic: KnowledgeTopic; score: number } | undefined;

  for (const topic of topics) {
    const score = topic.keywords.reduce(
      (total, keyword) => total + (normalized.includes(keyword.toLocaleLowerCase()) ? 1 : 0),
      0
    );
    if (score > (best?.score ?? 0)) best = { topic, score };
  }
  return best?.topic;
}

/** Client audience/topic fields are hints only; the server selects the topic from local knowledge. */
export function answerFromKnowledge(
  query: string,
  knowledge: LocalKnowledge,
  verifiedAudience: AudienceContext = AudienceContext.General
): AssistantReplyResult {
  const topic = findTopic(query, knowledge.topics);
  const reply = generateAssistantReply(query, verifiedAudience, topic?.topicId);
  // YAML is the backend's canonical answer text; the prototype engine still
  // supplies the established UI's structured steps and follow-up suggestions.
  return topic && !reply.guidance.boundaryNotice
    ? { ...reply, content: topic.content }
    : reply;
}

/** No identity middleware exists in Phase 1, so all requests receive general guidance. */
export function resolveVerifiedAudience(_request: unknown): AudienceContext {
  return AudienceContext.General;
}
