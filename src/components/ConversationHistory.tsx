import { useMemo, useState } from 'react';
import {
  ArrowUpRight,
  Menu,
  MessageSquare,
  Search,
  Trash2,
} from 'lucide-react';
import { AudienceContext, ConversationThread } from '../types/assistant';
import { filterConversations } from '../utils/assistantEngine';

interface ConversationHistoryProps {
  conversations: ConversationThread[];
  onOpenConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  onClearAll: () => void;
  onStartNew: () => void;
  onOpenMobileSidebar: () => void;
}

export function ConversationHistory({
  conversations,
  onOpenConversation,
  onDeleteConversation,
  onClearAll,
  onStartNew,
  onOpenMobileSidebar,
}: ConversationHistoryProps) {
  const [query, setQuery] = useState('');
  const [audienceFilter, setAudienceFilter] = useState<AudienceContext | 'ALL'>(
    'ALL'
  );

  const filtered = useMemo(
    () => filterConversations(conversations, query, audienceFilter),
    [conversations, query, audienceFilter]
  );

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-[#0B1220]">
      <header className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-b border-white/[0.08] px-4 py-2.5 lg:px-6 shrink-0">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onOpenMobileSidebar}
            aria-label="Open navigation sidebar"
            className="rounded-lg border border-white/[0.08] bg-[#111827] p-2 text-[#F8FAFC] hover:bg-[#1E293B] md:hidden"
          >
            <Menu className="h-4 w-4" aria-hidden="true" />
          </button>
          <div>
            <h1 className="font-display text-lg font-semibold text-[#F8FAFC]">
              Conversation History
            </h1>
            <p className="text-xs text-[#94A3B8]">
              Stored locally in your browser for quick reference
            </p>
          </div>
        </div>

        {conversations.length > 0 && (
          <button
            type="button"
            onClick={onClearAll}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-[#111827] px-3 py-1.5 text-xs font-medium text-[#EF4444] transition-colors hover:border-[#EF4444]/40 hover:bg-[#1E293B] whitespace-nowrap"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Clear All History</span>
          </button>
        )}
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6 lg:px-8">
        <div className="mx-auto max-w-[880px] space-y-5">
          {/* Empty History State */}
          {conversations.length === 0 ? (
            <section
              aria-label="Empty conversation history"
              className="rounded-xl border border-white/[0.08] bg-[#111827] px-6 py-14 text-center"
            >
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-white/[0.08] bg-[#1E293B]">
                <MessageSquare
                  className="h-5 w-5 text-[#60A5FA]"
                  aria-hidden="true"
                />
              </div>
              <h2 className="mt-4 font-display text-lg font-semibold text-[#F8FAFC]">
                No saved conversations yet
              </h2>
              <p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-[#94A3B8]">
                Your questions and UpToSkills guidance threads will appear here automatically once you start a conversation.
              </p>
              <button
                type="button"
                onClick={onStartNew}
                className="mt-5 rounded-lg bg-[#2563EB] px-4 py-2 text-xs font-semibold text-[#F8FAFC] hover:bg-[#1D4ED8]"
              >
                Start a Conversation
              </button>
            </section>
          ) : (
            <>
              {/* Filter Bar */}
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="relative flex-1 max-w-md">
                  <Search
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#94A3B8]"
                    aria-hidden="true"
                  />
                  <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search past questions or guidance..."
                    aria-label="Search conversation history"
                    className="w-full rounded-lg border border-white/[0.08] bg-[#111827] py-2 pl-9 pr-3 text-xs text-[#F8FAFC] placeholder:text-[#94A3B8] focus:border-[#2563EB] focus:outline-none focus:ring-2 focus:ring-[#2563EB]/30"
                  />
                </div>

                <div className="flex items-center gap-1 overflow-x-auto rounded-lg border border-white/[0.08] bg-[#111827] p-1">
                  {(
                    [
                      { value: 'ALL', label: 'All' },
                      { value: AudienceContext.Applicant, label: 'Applicant' },
                      { value: AudienceContext.Intern, label: 'Intern' },
                      { value: AudienceContext.CaptainOrLead, label: 'Lead' },
                      { value: AudienceContext.General, label: 'General' },
                    ] as const
                  ).map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      onClick={() => setAudienceFilter(item.value)}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
                        audienceFilter === item.value
                          ? 'bg-[#1E293B] text-[#F8FAFC]'
                          : 'text-[#94A3B8] hover:text-[#F8FAFC]'
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>

              {filtered.length === 0 ? (
                <section className="rounded-xl border border-white/[0.08] bg-[#111827] px-6 py-10 text-center">
                  <p className="font-display text-sm font-semibold text-[#F8FAFC]">
                    No conversations match your filter
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setQuery('');
                      setAudienceFilter('ALL');
                    }}
                    className="mt-3 rounded-lg border border-white/[0.08] bg-[#1E293B] px-3 py-1.5 text-xs font-medium text-[#F8FAFC] hover:bg-white/[0.08]"
                  >
                    Reset Filters
                  </button>
                </section>
              ) : (
                <div className="divide-y divide-white/[0.06] overflow-hidden rounded-xl border border-white/[0.08] bg-[#111827]">
                  {filtered.map((conv) => (
                    <div
                      key={conv.id}
                      className="flex flex-col gap-3 p-4 transition-colors hover:bg-white/[0.02] sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0 space-y-1">
                        <h2 className="font-display text-sm font-semibold text-[#F8FAFC] truncate">
                          {conv.title}
                        </h2>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-[#94A3B8]">
                          <span>{conv.audience}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums">
                            {conv.messages.length} messages
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums">{conv.updatedAt}</span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => onOpenConversation(conv.id)}
                          className="inline-flex items-center gap-1 rounded-lg bg-[#2563EB] px-3 py-1.5 text-xs font-semibold text-[#F8FAFC] hover:bg-[#1D4ED8] whitespace-nowrap"
                        >
                          <span>Resume</span>
                          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onDeleteConversation(conv.id)}
                          aria-label={`Delete conversation "${conv.title}"`}
                          className="rounded-lg border border-white/[0.08] bg-[#1E293B] p-1.5 text-[#94A3B8] hover:border-[#EF4444]/40 hover:text-[#EF4444]"
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </main>
  );
}
