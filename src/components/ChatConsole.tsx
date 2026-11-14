import { useEffect, useRef, useState } from 'react';
import { ChevronDown, LifeBuoy, Menu, Send, Square } from 'lucide-react';
import {
  AssistantMessage,
  AudienceContext,
  ConversationThread,
  AIModelOption,
  HelpTopicId,
  PdfAttachmentPayload,
} from '../types/assistant';
import { PdfAttachmentField } from './PdfAttachmentField';
import { ModelSelector } from './ModelSelector';
import { readPdfAttachment } from '../utils/pdfAttachment';
import { getRelevantTopicsForAudience } from '../utils/assistantEngine';
import {
  ErrorRetryCard,
  LoadingMessageCard,
  MessageCard,
} from './MessageCard';

interface ChatConsoleProps {
  conversation: ConversationThread;
  audience: AudienceContext;
  availableModels: AIModelOption[];
  selectedModel: string;
  modelAvailable: boolean;
  isLoading: boolean;
  streamingMessage: AssistantMessage | null;
  errorState: { message: string; failedPrompt: string } | null;
  onChangeAudience: (audience: AudienceContext) => void;
  onChangeModel: (model: string) => void;
  onSendMessage: (content: string, topicId?: HelpTopicId, attachment?: PdfAttachmentPayload) => void;
  onCancelOrStop: () => void;
  onRetryFailed: () => void;
  onOpenEscalation: () => void;
  onOpenMobileSidebar: () => void;
}

export function ChatConsole({
  conversation,
  audience,
  availableModels,
  selectedModel,
  modelAvailable,
  isLoading,
  streamingMessage,
  errorState,
  onChangeAudience,
  onChangeModel,
  onSendMessage,
  onCancelOrStop,
  onRetryFailed,
  onOpenEscalation,
  onOpenMobileSidebar,
}: ChatConsoleProps) {
  const [draft, setDraft] = useState('');
  const [pdf, setPdf] = useState<File | null>(null);
  const [pdfError, setPdfError] = useState('');
  const streamContainerRef = useRef<HTMLDivElement | null>(null);
  const streamEndRef = useRef<HTMLDivElement | null>(null);
  const prevThreadIdRef = useRef<string>(conversation.id);
  const prevMsgCountRef = useRef<number>(conversation.messages.length);

  const topicSuggestions = getRelevantTopicsForAudience(audience);

  useEffect(() => {
    if (prevThreadIdRef.current !== conversation.id) {
      prevThreadIdRef.current = conversation.id;
      prevMsgCountRef.current = conversation.messages.length;
      if (streamContainerRef.current) {
        streamContainerRef.current.scrollTop = 0;
      }
      return;
    }

    if (
      conversation.messages.length > prevMsgCountRef.current ||
      isLoading ||
      streamingMessage ||
      errorState
    ) {
      streamEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
    prevMsgCountRef.current = conversation.messages.length;
  }, [
    conversation.id,
    conversation.messages.length,
    isLoading,
    streamingMessage,
    errorState,
  ]);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if ((!draft.trim() && !pdf) || isLoading || streamingMessage) return;
    let attachment: PdfAttachmentPayload | undefined;
    if (pdf) {
      try {
        attachment = await readPdfAttachment(pdf);
      } catch (error) {
        setPdfError(error instanceof Error ? error.message : 'Could not read that PDF.');
        return;
      }
    }
    onSendMessage(draft.trim() || 'Please analyze this PDF and summarize its key points.', undefined, attachment);
    setDraft('');
    setPdf(null);
    setPdfError('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
  };

  const isBusy = isLoading || Boolean(streamingMessage);

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-[#0B1220]">
      {/* Active Conversation Header */}
      <header className="flex h-14 items-center justify-between gap-2 border-b border-white/[0.08] px-3 py-2 lg:px-6 shrink-0">
        <div className="flex min-w-0 items-center gap-2.5">
          <button
            type="button"
            onClick={onOpenMobileSidebar}
            aria-label="Open navigation sidebar"
            className="rounded-lg border border-white/[0.08] bg-[#111827] p-2 text-[#F8FAFC] hover:bg-[#1E293B] md:hidden shrink-0"
          >
            <Menu className="h-4 w-4" aria-hidden="true" />
          </button>

          <div className="min-w-0">
            <h1 className="font-display text-sm sm:text-base font-semibold text-[#F8FAFC] truncate">
              {conversation.title}
            </h1>
            <p className="text-[11px] sm:text-xs text-[#94A3B8] truncate">
              Context: {audience} · Advisory guidance only
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <ModelSelector models={availableModels} value={selectedModel} onChange={onChangeModel} modelAvailable={modelAvailable} />
          <div className="relative hidden sm:block">
            <label htmlFor="chat-audience-select" className="sr-only">
              Audience context preference
            </label>
            <select
              id="chat-audience-select"
              value={audience}
              onChange={(e) => onChangeAudience(e.target.value as AudienceContext)}
              className="appearance-none rounded-lg border border-white/[0.08] bg-[#111827] py-1.5 pl-2.5 pr-8 text-xs text-[#F8FAFC] focus:border-[#2563EB] focus:outline-none"
            >
              <option value={AudienceContext.Applicant}>Applicant</option>
              <option value={AudienceContext.Intern}>Intern</option>
              <option value={AudienceContext.CaptainOrLead}>Captain / Team Lead</option>
              <option value={AudienceContext.General}>General</option>
            </select>
            <ChevronDown
              className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#94A3B8]"
              aria-hidden="true"
            />
          </div>

          <button
            type="button"
            onClick={onOpenEscalation}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-[#111827] px-2.5 sm:px-3 py-1.5 text-xs font-medium text-[#F8FAFC] transition-colors hover:border-[#F97316]/50 hover:bg-[#1E293B] whitespace-nowrap"
          >
            <LifeBuoy className="h-3.5 w-3.5 text-[#F97316]" aria-hidden="true" />
            <span className="hidden sm:inline">Human Support</span>
            <span className="sm:hidden">Support</span>
          </button>
        </div>
      </header>

      {/* Scrollable Thread */}
      <div
        ref={streamContainerRef}
        className="flex-1 overflow-y-auto px-4 py-6 lg:px-8"
      >
        <div className="mx-auto max-w-[840px] space-y-5">
          {conversation.messages.map((msg) => (
            <MessageCard
              key={msg.id}
              message={msg}
              onSelectFollowUp={(q) => onSendMessage(q)}
              onOpenEscalation={onOpenEscalation}
            />
          ))}

          {isLoading && <LoadingMessageCard onCancel={onCancelOrStop} />}

          {streamingMessage && (
            <MessageCard message={streamingMessage} isStreaming />
          )}

          {errorState && !isBusy && (
            <ErrorRetryCard
              errorMessage={errorState.message}
              onRetry={onRetryFailed}
              onOpenEscalation={onOpenEscalation}
            />
          )}

          <div ref={streamEndRef} />
        </div>
      </div>

      {/* Topic Suggestions + Accessible Chat Composer */}
      <div className="border-t border-white/[0.08] bg-[#0B1220] px-4 py-3 lg:px-8 shrink-0">
        <div className="mx-auto max-w-[840px] space-y-2.5">
          {!isBusy && (
            <div
              className="flex flex-nowrap overflow-x-auto sm:flex-wrap items-center gap-2 pb-0.5 sm:pb-0"
              role="group"
              aria-label="Relevant help topics"
            >
              {topicSuggestions.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => onSendMessage(item.prompt, item.topicId)}
                  className="rounded-lg border border-white/[0.08] bg-[#1E293B] px-3 py-1.5 text-xs font-medium text-[#cbd5e1] transition-colors hover:border-[#F97316]/50 hover:text-white whitespace-nowrap shrink-0"
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}

          <form
            onSubmit={handleSubmit}
            className="rounded-xl border border-white/[0.12] bg-[#111827] transition-all focus-within:border-[#2563EB] focus-within:ring-2 focus-within:ring-[#2563EB]/30"
          >
            <label htmlFor="chat-composer-input" className="sr-only">
              Ask a follow-up question
            </label>
            <textarea
              id="chat-composer-input"
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask a follow-up question about UpToSkills internships, InternOps, or policies..."
              className="w-full resize-none bg-transparent px-4 pt-3 pb-2 text-sm text-[#F8FAFC] placeholder:text-[#94A3B8] focus:outline-none"
            />

            <div className="flex items-center justify-between gap-2 border-t border-white/[0.06] px-3 py-2">
              <div className="flex min-w-0 flex-col gap-1">
                <PdfAttachmentField file={pdf} error={pdfError} disabled={isBusy} onChange={(file, error) => { setPdf(file); setPdfError(error); }} />
                <span className="font-mono text-[10px] text-[#64748B]">
                  Guidance only · Ctrl+Enter to send
                </span>
              </div>

              {isBusy ? (
                <button
                  type="button"
                  onClick={onCancelOrStop}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#F97316] px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-[#ea580c] whitespace-nowrap"
                >
                  <Square className="h-3 w-3 fill-current" aria-hidden="true" />
                  <span>Stop</span>
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!draft.trim()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#2563EB] px-4 py-1.5 text-xs font-semibold text-[#F8FAFC] transition-colors hover:bg-[#1D4ED8] disabled:cursor-not-allowed disabled:opacity-45 whitespace-nowrap"
                >
                  <Send className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Send</span>
                </button>
              )}
            </div>
          </form>
        </div>
      </div>
    </main>
  );
}
