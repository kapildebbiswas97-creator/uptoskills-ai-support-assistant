import { useState } from 'react';
import {
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Info,
  Mail,
  Menu,
  Phone,
  Users,
} from 'lucide-react';
import { AudienceContext, EscalationCategory } from '../types/assistant';
import {
  ESCALATION_CATEGORY_GUIDANCE,
  OFFICIAL_SUPPORT,
} from '../data/uptoskillsKnowledge';
import {
  buildEscalationSummary,
  validateEscalationInput,
} from '../utils/assistantEngine';

interface HumanSupportEscalationProps {
  audience: AudienceContext;
  onOpenMobileSidebar: () => void;
}

export function HumanSupportEscalation({
  audience,
  onOpenMobileSidebar,
}: HumanSupportEscalationProps) {
  const [category, setCategory] = useState<EscalationCategory>(
    EscalationCategory.AttendanceRecord
  );
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [preparedSummary, setPreparedSummary] = useState<string | null>(null);
  const [copiedEmail, setCopiedEmail] = useState(false);
  const [copiedPhone, setCopiedPhone] = useState(false);
  const [copiedSummary, setCopiedSummary] = useState(false);

  const categoryInfo = ESCALATION_CATEGORY_GUIDANCE[category];

  const handleCopyValue = async (
    value: string,
    setter: (v: boolean) => void
  ) => {
    try {
      await navigator.clipboard.writeText(value);
      setter(true);
      setTimeout(() => setter(false), 1800);
    } catch {
      setter(true);
      setTimeout(() => setter(false), 1800);
    }
  };

  const handlePrepareSummary = (e: React.FormEvent) => {
    e.preventDefault();
    const validation = validateEscalationInput(description);
    if (!validation.valid) {
      setError(validation.errors.description);
      setPreparedSummary(null);
      return;
    }
    setError(undefined);
    setPreparedSummary(
      buildEscalationSummary({
        category,
        audience,
        description,
      })
    );
  };

  const mailtoHref = preparedSummary
    ? `mailto:${OFFICIAL_SUPPORT.email}?subject=${encodeURIComponent(
        `UpToSkills Support: ${category}`
      )}&body=${encodeURIComponent(preparedSummary)}`
    : `mailto:${OFFICIAL_SUPPORT.email}`;

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-[#0B1220]">
      <header className="flex min-h-14 items-center justify-between gap-3 border-b border-white/[0.08] px-4 py-2.5 lg:px-6 shrink-0">
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
              Human Support & Escalation
            </h1>
            <p className="text-xs text-[#94A3B8]">
              General UpToSkills support contacts and guidance for reaching your assigned Captain or Team Lead
            </p>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6 lg:px-8">
        <div className="mx-auto max-w-[880px] space-y-6">
          {/* UpToSkills Support Channels */}
          <section
            aria-label="UpToSkills support contact details"
            className="grid grid-cols-1 gap-4 md:grid-cols-3"
          >
            <div className="rounded-xl border border-white/[0.08] bg-[#111827] p-4 space-y-2.5">
              <div className="flex items-center gap-2 text-xs font-medium text-[#94A3B8]">
                <Mail className="h-4 w-4 text-[#60A5FA]" aria-hidden="true" />
                <span>UpToSkills Support Email</span>
              </div>
              <p className="font-mono text-sm font-medium text-[#F8FAFC] break-all">
                {OFFICIAL_SUPPORT.email}
              </p>
              <div className="flex items-center gap-2 pt-1">
                <a
                  href={`mailto:${OFFICIAL_SUPPORT.email}`}
                  className="rounded-lg bg-[#2563EB] px-3 py-1.5 text-xs font-semibold text-[#F8FAFC] hover:bg-[#1D4ED8]"
                >
                  Email Support
                </a>
                <button
                  type="button"
                  onClick={() =>
                    handleCopyValue(OFFICIAL_SUPPORT.email, setCopiedEmail)
                  }
                  aria-label="Copy support email address"
                  className="inline-flex items-center gap-1 rounded-lg border border-white/[0.08] bg-[#1E293B] px-2.5 py-1.5 font-mono text-[11px] text-[#F8FAFC] hover:border-white/[0.2]"
                >
                  {copiedEmail ? (
                    <>
                      <Check className="h-3 w-3 text-[#10B981]" aria-hidden="true" />
                      <span className="text-[#10B981]">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3 w-3 text-[#94A3B8]" aria-hidden="true" />
                      <span>Copy</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            <div className="rounded-xl border border-white/[0.08] bg-[#111827] p-4 space-y-2.5">
              <div className="flex items-center gap-2 text-xs font-medium text-[#94A3B8]">
                <Phone className="h-4 w-4 text-[#F97316]" aria-hidden="true" />
                <span>UpToSkills Support Phone</span>
              </div>
              <p className="font-mono text-sm font-medium tabular-nums text-[#F8FAFC]">
                {OFFICIAL_SUPPORT.phone}
              </p>
              <div className="flex items-center gap-2 pt-1">
                <a
                  href={`tel:${OFFICIAL_SUPPORT.phone}`}
                  className="rounded-lg border border-white/[0.08] bg-[#1E293B] px-3 py-1.5 text-xs font-semibold text-[#F8FAFC] hover:border-[#F97316]/50"
                >
                  Call Support
                </a>
                <button
                  type="button"
                  onClick={() =>
                    handleCopyValue(OFFICIAL_SUPPORT.phone, setCopiedPhone)
                  }
                  aria-label="Copy support phone number"
                  className="inline-flex items-center gap-1 rounded-lg border border-white/[0.08] bg-[#1E293B] px-2.5 py-1.5 font-mono text-[11px] text-[#F8FAFC] hover:border-white/[0.2]"
                >
                  {copiedPhone ? (
                    <>
                      <Check className="h-3 w-3 text-[#10B981]" aria-hidden="true" />
                      <span className="text-[#10B981]">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3 w-3 text-[#94A3B8]" aria-hidden="true" />
                      <span>Copy</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            <div className="rounded-xl border border-white/[0.08] bg-[#111827] p-4 space-y-2">
              <div className="flex items-center gap-2 text-xs font-medium text-[#94A3B8]">
                <Users className="h-4 w-4 text-[#10B981]" aria-hidden="true" />
                <span>Operational Cohort Lead</span>
              </div>
              <p className="text-xs font-semibold text-[#F8FAFC]">
                Assigned Captain or Team Lead
              </p>
              <p className="text-xs leading-relaxed text-[#94A3B8]">
                For attendance updates, daily task review clarifications, and cohort-level operational help, contact your assigned Captain or Team Lead directly.
              </p>
            </div>
          </section>

          {/* Guided Escalation Preparation Form */}
          <section className="grid grid-cols-1 gap-6 lg:grid-cols-5">
            <form
              onSubmit={handlePrepareSummary}
              noValidate
              className="lg:col-span-3 rounded-xl border border-white/[0.08] bg-[#111827] p-5 space-y-4"
            >
              <div>
                <h2 className="font-display text-base font-semibold text-[#F8FAFC]">
                  Prepare a Support Escalation Summary
                </h2>
                <p className="mt-1 text-xs text-[#94A3B8]">
                  Draft a clear summary to copy and send via email or share with your assigned Captain / Team Lead.
                </p>
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="escalation-category"
                  className="block text-xs font-medium text-[#cbd5e1]"
                >
                  Issue Category
                </label>
                <div className="relative">
                  <select
                    id="escalation-category"
                    value={category}
                    onChange={(e) => {
                      setCategory(e.target.value as EscalationCategory);
                      setPreparedSummary(null);
                    }}
                    className="w-full appearance-none rounded-lg border border-white/[0.1] bg-[#0B1220] py-2 pl-3 pr-9 text-xs text-[#F8FAFC] focus:border-[#2563EB] focus:outline-none focus:ring-2 focus:ring-[#2563EB]/30"
                  >
                    {Object.values(EscalationCategory).map((cat) => (
                      <option key={cat} value={cat}>
                        {cat}
                      </option>
                    ))}
                  </select>
                  <ChevronDown
                    className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#94A3B8]"
                    aria-hidden="true"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="escalation-description"
                  className="block text-xs font-medium text-[#cbd5e1]"
                >
                  Short Issue Description
                </label>
                <textarea
                  id="escalation-description"
                  rows={4}
                  value={description}
                  onChange={(e) => {
                    setDescription(e.target.value);
                    if (error) setError(undefined);
                  }}
                  placeholder="Describe the issue clearly (do not include passwords, OTPs, or private session tokens)..."
                  className="w-full resize-none rounded-lg border border-white/[0.1] bg-[#0B1220] p-3 text-xs leading-relaxed text-[#F8FAFC] placeholder:text-[#94A3B8] focus:border-[#2563EB] focus:outline-none focus:ring-2 focus:ring-[#2563EB]/30"
                />
                {error && (
                  <p role="alert" className="text-xs text-[#EF4444]">
                    {error}
                  </p>
                )}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <span className="font-mono text-[11px] text-[#94A3B8]">
                  Context: {audience}
                </span>
                <button
                  type="submit"
                  className="rounded-lg bg-[#2563EB] px-4 py-2 text-xs font-semibold text-[#F8FAFC] hover:bg-[#1D4ED8]"
                >
                  Prepare Support Summary
                </button>
              </div>

              {preparedSummary && (
                <div className="space-y-3 rounded-lg border border-[#F59E0B]/35 bg-[#0B1220] p-4">
                  <div className="flex items-start gap-2 text-xs text-[#FDE68A]">
                    <Info
                      className="mt-0.5 h-4 w-4 shrink-0 text-[#F59E0B]"
                      aria-hidden="true"
                    />
                    <span>
                      No backend ticket system is connected—nothing has been submitted automatically. Copy this draft or open your email app to send it to {OFFICIAL_SUPPORT.email} or your assigned Captain / Team Lead.
                    </span>
                  </div>

                  <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border border-white/[0.06] bg-[#111827] p-3 font-mono text-xs leading-relaxed text-[#E2E8F0]">
                    {preparedSummary}
                  </pre>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        handleCopyValue(preparedSummary, setCopiedSummary)
                      }
                      className="inline-flex items-center gap-1.5 rounded-lg bg-[#1E293B] px-3 py-1.5 text-xs font-medium text-[#F8FAFC] hover:bg-white/[0.1]"
                    >
                      {copiedSummary ? (
                        <>
                          <Check
                            className="h-3.5 w-3.5 text-[#10B981]"
                            aria-hidden="true"
                          />
                          <span className="text-[#10B981]">Summary Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Copy Summary</span>
                        </>
                      )}
                    </button>
                    <a
                      href={mailtoHref}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-[#F97316] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#ea580c]"
                    >
                      <span>Open in Email Client</span>
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                    </a>
                  </div>
                </div>
              )}
            </form>

            {/* Relevant Help Guidance & Contact Instructions */}
            <aside className="lg:col-span-2 rounded-xl border border-white/[0.08] bg-[#111827] p-5 space-y-4">
              <div>
                <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-[#F97316]">
                  Recommended Routing
                </p>
                <h3 className="mt-1 font-display text-sm font-semibold text-[#F8FAFC]">
                  {categoryInfo.primaryContact}
                </h3>
                <p className="mt-1.5 text-xs leading-relaxed text-[#94A3B8]">
                  {categoryInfo.guidance}
                </p>
              </div>

              <div className="border-t border-white/[0.06] pt-3 space-y-2">
                <p className="text-xs font-medium text-[#cbd5e1]">
                  Before contacting support:
                </p>
                <ul className="space-y-2">
                  {categoryInfo.checklist.map((item, idx) => (
                    <li
                      key={idx}
                      className="flex items-start gap-2 text-xs leading-relaxed text-[#94A3B8]"
                    >
                      <span className="mt-0.5 font-mono text-[11px] font-semibold text-[#60A5FA]">
                        {idx + 1}.
                      </span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="border-t border-white/[0.06] pt-3 text-xs text-[#94A3B8] space-y-1">
                <p className="font-medium text-[#cbd5e1]">Official Reference Portals</p>
                <div className="flex flex-col gap-1">
                  <a
                    href={OFFICIAL_SUPPORT.internshipPortalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[#60A5FA] hover:underline"
                  >
                    <span>uptoskills.com/intern-with-uptoskills</span>
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                  <a
                    href={OFFICIAL_SUPPORT.internOpsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[#60A5FA] hover:underline"
                  >
                    <span>internops.uptoskills.com</span>
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                </div>
              </div>
            </aside>
          </section>
        </div>
      </div>
    </main>
  );
}
