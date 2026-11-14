import { useState } from 'react';
import {
  ArrowRight,
  ExternalLink,
  LifeBuoy,
  Menu,
  Send,
} from 'lucide-react';
import { AIModelOption, AudienceContext, PdfAttachmentPayload, QuickActionItem } from '../types/assistant';
import {
  AUDIENCE_CONTEXT_DESCRIPTIONS,
  OFFICIAL_SUPPORT,
  WELCOME_QUICK_ACTIONS,
} from '../data/uptoskillsKnowledge';
import { BrandMark } from './BrandMark';
import { PdfAttachmentField } from './PdfAttachmentField';
import { ModelSelector } from './ModelSelector';
import { readPdfAttachment } from '../utils/pdfAttachment';

interface WelcomeScreenProps {
  audience: AudienceContext;
  availableModels: AIModelOption[];
  selectedModel: string;
  modelAvailable: boolean;
  onChangeAudience: (audience: AudienceContext) => void;
  onChangeModel: (model: string) => void;
  onSelectQuickAction: (action: QuickActionItem) => void;
  onSubmitQuestion: (question: string, attachment?: PdfAttachmentPayload) => void;
  onOpenMobileSidebar: () => void;
}

export function WelcomeScreen({
  audience,
  availableModels,
  selectedModel,
  modelAvailable,
  onChangeAudience,
  onChangeModel,
  onSelectQuickAction,
  onSubmitQuestion,
  onOpenMobileSidebar,
}: WelcomeScreenProps) {
  const [question, setQuestion] = useState('');
  const [pdf, setPdf] = useState<File | null>(null);
  const [pdfError, setPdfError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!question.trim() && !pdf) return;
    let attachment: PdfAttachmentPayload | undefined;
    if (pdf) {
      try {
        attachment = await readPdfAttachment(pdf);
      } catch (error) {
        setPdfError(error instanceof Error ? error.message : 'Could not read that PDF.');
        return;
      }
    }
    onSubmitQuestion(question.trim() || 'Please analyze this PDF and summarize its key points.', attachment);
    setQuestion('');
    setPdf(null);
    setPdfError('');
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-[#0B1220]">
      {/* Minimal Header */}
      <header className="flex h-14 items-center justify-between gap-3 border-b border-white/[0.08] px-4 lg:px-6 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={onOpenMobileSidebar}
            aria-label="Open navigation sidebar"
            className="rounded-lg border border-white/[0.08] bg-[#111827] p-2 text-[#F8FAFC] hover:bg-[#1E293B] md:hidden"
          >
            <Menu className="h-4 w-4" aria-hidden="true" />
          </button>
          <BrandMark className="h-8 w-[76px]" />
          <span className="font-display text-sm font-semibold text-[#F8FAFC] truncate">
            {OFFICIAL_SUPPORT.brandName}
          </span>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <ModelSelector models={availableModels} value={selectedModel} onChange={onChangeModel} modelAvailable={modelAvailable} className="hidden sm:flex" />
          <a
            href={OFFICIAL_SUPPORT.internshipPortalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="hidden sm:inline-flex items-center gap-1 text-xs font-medium text-[#94A3B8] hover:text-[#F8FAFC] whitespace-nowrap"
          >
            <span>Internships Portal</span>
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
          <a
            href={OFFICIAL_SUPPORT.internOpsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-lg border border-white/[0.08] bg-[#111827] px-3 py-1.5 text-xs font-medium text-[#F8FAFC] hover:bg-[#1E293B] whitespace-nowrap"
          >
            <span>InternOps</span>
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-8 lg:px-8">
        <div className="mx-auto max-w-[880px] space-y-8">
          {/* Welcome Intro */}
          <section className="space-y-3">
            <h1 className="font-display text-2xl font-bold tracking-tight text-[#F8FAFC] sm:text-3xl text-balance">
              UpToSkills AI Support Assistant
            </h1>
            <p className="max-w-2xl text-sm leading-relaxed text-[#94A3B8] sm:text-[15px]">
              Advisory and navigation support for internship applicants, interns, Captains, and Team Leads using UpToSkills and InternOps. Ask a question or pick a topic below—this assistant provides guidance only and does not modify records or access private accounts.
            </p>
          </section>

          {/* Audience Context Preference */}
          <section
            aria-label="Audience context preference"
            className="rounded-xl border border-white/[0.08] bg-[#111827] p-4 space-y-3"
          >
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="font-display text-sm font-semibold text-[#F8FAFC]">
                Choose your conversational context
              </h2>
              <span className="font-mono text-[11px] text-[#94A3B8]">
                Preference only · Not authentication or permissions
              </span>
            </div>

            <div className="flex flex-wrap gap-2" role="group" aria-label="Audience context options">
              {(
                [
                  AudienceContext.Applicant,
                  AudienceContext.Intern,
                  AudienceContext.CaptainOrLead,
                  AudienceContext.General,
                ] as const
              ).map((option) => {
                const active = audience === option;
                return (
                  <button
                    key={option}
                    type="button"
                    onClick={() => onChangeAudience(option)}
                    aria-pressed={active}
                    className={`rounded-lg border px-3.5 py-2 text-xs font-medium transition-colors whitespace-nowrap ${
                      active
                        ? 'border-[#2563EB] bg-[#2563EB]/20 text-[#F8FAFC]'
                        : 'border-white/[0.08] bg-[#1E293B] text-[#cbd5e1] hover:border-white/[0.18] hover:text-white'
                    }`}
                  >
                    {option}
                  </button>
                );
              })}
            </div>

            <p className="text-xs text-[#94A3B8]">
              {AUDIENCE_CONTEXT_DESCRIPTIONS[audience]}
            </p>
          </section>

          {/* 8 Quick Actions */}
          <section aria-label="Quick help actions" className="space-y-3">
            <h2 className="font-display text-sm font-semibold text-[#F8FAFC]">
              Common UpToSkills Support Topics
            </h2>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {WELCOME_QUICK_ACTIONS.map((action) => {
                const isSupport = Boolean(action.opensEscalation);
                return (
                  <button
                    key={action.id}
                    type="button"
                    onClick={() => onSelectQuickAction(action)}
                    className={`group flex flex-col justify-between rounded-xl border p-4 text-left transition-colors ${
                      isSupport
                        ? 'border-[#F97316]/35 bg-[#111827] hover:border-[#F97316] hover:bg-[#1E293B]'
                        : 'border-white/[0.08] bg-[#111827] hover:border-[#2563EB]/60 hover:bg-[#1E293B]'
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-display text-sm font-semibold text-[#F8FAFC]">
                          {action.label}
                        </span>
                        {isSupport ? (
                          <LifeBuoy
                            className="h-4 w-4 shrink-0 text-[#F97316]"
                            aria-hidden="true"
                          />
                        ) : (
                          <ArrowRight
                            className="h-3.5 w-3.5 shrink-0 text-[#94A3B8] transition-transform group-hover:translate-x-0.5 group-hover:text-[#F8FAFC]"
                            aria-hidden="true"
                          />
                        )}
                      </div>
                      <p className="mt-1.5 text-xs leading-relaxed text-[#94A3B8]">
                        {action.description}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          {/* Direct Composer */}
          <section aria-label="Ask a question">
            <form
              onSubmit={handleSubmit}
              className="rounded-xl border border-white/[0.12] bg-[#111827] p-2 transition-all focus-within:border-[#2563EB] focus-within:ring-2 focus-within:ring-[#2563EB]/30"
            >
              <label htmlFor="welcome-question-input" className="sr-only">
                Ask an UpToSkills support question
              </label>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <input
                  id="welcome-question-input"
                  type="text"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder="Ask anything, or attach a PDF to analyze..."
                  className="flex-1 bg-transparent px-3 py-2 text-sm text-[#F8FAFC] placeholder:text-[#94A3B8] focus:outline-none"
                />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] px-2 pt-2">
                <PdfAttachmentField file={pdf} error={pdfError} onChange={(file, error) => { setPdf(file); setPdfError(error); }} />
                <button
                  type="submit"
                  disabled={!question.trim() && !pdf}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#2563EB] px-4 py-2 text-xs font-semibold text-[#F8FAFC] transition-colors hover:bg-[#1D4ED8] disabled:cursor-not-allowed disabled:opacity-45 whitespace-nowrap shrink-0"
                >
                  <Send className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Ask Assistant</span>
                </button>
              </div>
            </form>
          </section>
        </div>
      </div>
    </main>
  );
}
