import { logEvent } from './observability.js';

export type OpenRouterUsageStatus = 'complete' | 'incomplete' | 'unavailable' | 'cancelled' | 'interrupted' | 'error';

export interface OpenRouterUsageMetadata {
  provider: 'openrouter';
  requestedModel: string;
  actualModel?: string;
  generationId?: string;
  responseId?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  providerReportedCost?: number;
  providerReportedCostUnit?: 'credits';
  upstreamInferenceCost?: number;
  upstreamInferencePromptCost?: number;
  upstreamInferenceCompletionsCost?: number;
  serverToolCostUsd?: number | null;
  usageReceived: boolean;
  usageComplete: boolean;
  usageStatus: OpenRouterUsageStatus;
  providerCostReported: boolean;
}

export type OpenRouterUsageReporter = (usage: OpenRouterUsageMetadata) => void;

export function logOpenRouterUsage(requestId: string | undefined, usage: OpenRouterUsageMetadata): void {
  logEvent('ai.provider.usage', { requestId, ...usage });
}
