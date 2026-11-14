import { useState } from 'react';
import {
  AlertCircle,
  Check,
  Copy,
  ExternalLink,
  Info,
  LifeBuoy,
  RefreshCw,
} from 'lucide-react';
import { AssistantMessage, MessageRole } from '../types/assistant';

function renderMessageContent(content: string) {
  return content.split(/(https?:\/\/[^\s<>"']+)/g).map((part, index) => {
    if (!/^https?:\/\//i.test(part)) return part;
    return (
      <a key={`${part}-${index}`} href={part} target="_blank" rel="noopener noreferrer" className="text-[#60A5FA] underline decoration-[#60A5FA]/40 underline-offset-2 hover:text-white">
        {part}
      </a>
    );
  });
}

interface MessageCardProps {
  message: AssistantMessage;
  isStreaming?: boolean;
  onSelectFollowUp?: (question: string) => void;
  onOpenEscalation?: () => void;
}

export function MessageCard({
  message,
  isStreaming = false,
  onSelectFollowUp,
  onOpenEscalation,
}: MessageCardProps) {
  const [copied, setCopied] = useState(false);

  if (message.role === MessageRole.User) {
    return (
      <article className="flex justify-end">
        <div className="w-full max-w-[660px] rounded-xl border border-white/[0.08] bg-[#1E293B] p-4">
          <div className="mb-1 flex items-center justify-between gap-4">
            <span className="text-xs font-medium text-[#cbd5e1]">You</span>
            <span className="font-mono text-[11px] tabular-nums text-[#94A3B8]">
              {message.timestamp}
            </span>
          </div>
          <p className="text-sm leading-relaxed text-[#F8FAFC] whitespace-pre-wrap">
            {message.content}
          </p>
        </div>
      </article>
    );
  }

  const buildCopyText = () => {
    const parts = [message.content];
    if (message.guidance) {
      parts.push(`\n${message.guidance.title}`);
      parts.push(
        ...message.guidance.steps.map((step, i) => `${i + 1}. ${step}`)
      );
      if (message.guidance.notes?.length) {
        parts.push(...message.guidance.notes.map((n) => `- ${n}`));
      }
    }
    return parts.join('\n');
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(buildCopyText());
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  };

  return (
    <article className="flex justify-start">
      <div className="w-full rounded-xl border border-white/[0.08] bg-[#111827] p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-[#F97316]">
            {isStreaming ? 'Responding' : 'UpToSkills Assistant'}
          </span>

          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] tabular-nums text-[#94A3B8]">
              {message.timestamp}
            </span>
            {!isStreaming && (
              <button
                type="button"
                onClick={handleCopy}
                aria-label="Copy response"
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-[#1E293B] px-2.5 py-1 font-mono text-[11px] font-medium text-[#F8FAFC] transition-colors hover:border-white/[0.2]"
              >
                {copied ? (
                  <>
                    <Check className="h-3 w-3 text-[#10B981]" aria-hidden="true" />
                    <span className="text-[#10B981]">Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3 w-3 text-[#94A3B8]" aria-hidden="true" />
                    <span>Copy response</span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>

        {/* Main Answer Prose */}
        <p className="text-sm leading-[23px] text-[#F8FAFC] whitespace-pre-wrap">
          {renderMessageContent(message.content)}
          {isStreaming && (
            <span
              className="ml-1 inline-block h-4 w-1.5 align-middle bg-[#F97316]"
              aria-hidden="true"
            />
          )}
        </p>

        {/* Structured Guidance & Step-by-step Instructions */}
        {!isStreaming && message.guidance && (
          <div className="space-y-3 rounded-lg border border-white/[0.08] bg-[#0B1220] p-4">
            <div>
              <h3 className="font-display text-sm font-semibold text-[#F8FAFC]">
                {message.guidance.title}
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-[#94A3B8]">
                {message.guidance.summary}
              </p>
            </div>

            {message.guidance.steps.length > 0 && (
              <ol className="space-y-2 pt-1">
                {message.guidance.steps.map((step, index) => (
                  <li
                    key={index}
                    className="flex items-start gap-2.5 text-xs leading-relaxed text-[#E2E8F0]"
                  >
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-[#2563EB]/20 font-mono text-[11px] font-semibold tabular-nums text-[#60A5FA]">
                      {index + 1}
                    </span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
            )}

            {message.guidance.notes && message.guidance.notes.length > 0 && (
              <div className="border-t border-white/[0.06] pt-2.5 space-y-1.5">
                {message.guidance.notes.map((note, idx) => (
                  <div
                    key={idx}
                    className="flex items-start gap-2 text-xs text-[#94A3B8]"
                  >
                    <Info
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#F59E0B]"
                      aria-hidden="true"
                    />
                    <span>{note}</span>
                  </div>
                ))}
              </div>
            )}

            {message.guidance.boundaryNotice && (
              <div className="rounded-lg border border-[#F59E0B]/30 bg-[#F59E0B]/10 p-3 text-xs text-[#FDE68A]">
                {message.guidance.boundaryNotice}
              </div>
            )}

            {message.guidance.references && message.guidance.references.length > 0 && (
              <div className="flex flex-wrap items-center gap-3 border-t border-white/[0.06] pt-2.5">
                {message.guidance.references.map((ref) => (
                  <a
                    key={ref.url}
                    href={ref.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-medium text-[#60A5FA] hover:underline"
                  >
                    <span>{ref.label}</span>
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Follow-up Questions & Escalation Link */}
        {!isStreaming && (message.followUps?.length || message.suggestEscalation) && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {message.followUps?.map((followUp) => (
              <button
                key={followUp}
                type="button"
                onClick={() => onSelectFollowUp?.(followUp)}
                className="rounded-lg border border-white/[0.08] bg-[#1E293B] px-3 py-1.5 text-left text-xs font-medium text-[#cbd5e1] transition-colors hover:border-[#F97316]/50 hover:text-white"
              >
                {followUp}
              </button>
            ))}

            {message.suggestEscalation && onOpenEscalation && (
              <button
                type="button"
                onClick={onOpenEscalation}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#F97316] px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-[#ea580c] whitespace-nowrap"
              >
                <LifeBuoy className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Contact Human Support</span>
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

interface LoadingMessageCardProps {
  onCancel: () => void;
}

export function LoadingMessageCard({ onCancel }: LoadingMessageCardProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-xl border border-white/[0.08] bg-[#111827] p-5 space-y-3"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-[#F97316]">
          Preparing UpToSkills guidance...
        </span>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-white/[0.08] bg-[#1E293B] px-2.5 py-1 text-xs font-medium text-[#F8FAFC] hover:bg-white/[0.1]"
        >
          Cancel
        </button>
      </div>
      <div className="space-y-2 animate-pulse" aria-hidden="true">
        <div className="h-3.5 w-3/4 rounded bg-[#1E293B]" />
        <div className="h-3.5 w-full rounded bg-[#1E293B]" />
        <div className="h-3.5 w-2/3 rounded bg-[#1E293B]" />
      </div>
    </div>
  );
}

interface ErrorRetryCardProps {
  errorMessage: string;
  onRetry: () => void;
  onOpenEscalation: () => void;
}

export function ErrorRetryCard({
  errorMessage,
  onRetry,
  onOpenEscalation,
}: ErrorRetryCardProps) {
  return (
    <div
      role="alert"
      className="rounded-xl border border-[#EF4444]/40 bg-[#111827] p-5 space-y-3"
    >
      <div className="flex items-start gap-3">
        <AlertCircle
          className="mt-0.5 h-5 w-5 shrink-0 text-[#EF4444]"
          aria-hidden="true"
        />
        <div className="space-y-1">
          <h3 className="font-display text-sm font-semibold text-[#F8FAFC]">
            Unable to generate guidance right now
          </h3>
          <p className="text-xs leading-relaxed text-[#94A3B8]">{errorMessage}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[#2563EB] px-3.5 py-2 text-xs font-semibold text-[#F8FAFC] hover:bg-[#1D4ED8]"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Retry</span>
        </button>
        <button
          type="button"
          onClick={onOpenEscalation}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-[#1E293B] px-3.5 py-2 text-xs font-medium text-[#F8FAFC] hover:border-[#F97316]/50"
        >
          <LifeBuoy className="h-3.5 w-3.5 text-[#F97316]" aria-hidden="true" />
          <span>Contact Human Support</span>
        </button>
      </div>
    </div>
  );
}
