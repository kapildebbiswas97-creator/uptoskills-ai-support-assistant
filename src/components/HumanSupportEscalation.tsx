import { useEffect, useRef, useState } from 'react';
import { Inbox, LifeBuoy, Menu, Send, TicketCheck } from 'lucide-react';
import { AudienceContext, EscalationCategory } from '../types/assistant';
import { ESCALATION_CONSENT_TEXT, ESCALATION_CONSENT_VERSION } from '../utils/escalationConsent';
import { apiFetch } from '../utils/apiClient';

interface TicketSummary {
  id: string;
  reference: string;
  subject: string;
  description: string;
  category: string | null;
  status: 'open' | 'in_progress' | 'resolved' | 'closed';
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  version: number;
  statusHistory: Array<{ from: string | null; to: string; changedAt: string }>;
}

interface HumanSupportEscalationProps {
  audience: AudienceContext;
  conversationId?: string | null;
  authenticated: boolean;
  authMessage: string;
  showHrEscalations: boolean;
  onOpenHrEscalations: () => void;
  onOpenMobileSidebar: () => void;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleString();
}

export function HumanSupportEscalation({
  audience,
  conversationId,
  authenticated,
  authMessage,
  showHrEscalations,
  onOpenHrEscalations,
  onOpenMobileSidebar,
}: HumanSupportEscalationProps) {
  const [view, setView] = useState<'new' | 'mine'>('new');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<string>('');
  const [consented, setConsented] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [createdTicket, setCreatedTicket] = useState<TicketSummary | null>(null);
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [selectedTicket, setSelectedTicket] = useState<TicketSummary | null>(null);
  const [loadingTickets, setLoadingTickets] = useState(false);
  const [ticketsError, setTicketsError] = useState('');
  const idempotencyKey = useRef(crypto.randomUUID());

  const loadTickets = async () => {
    if (!authenticated) return;
    setLoadingTickets(true);
    setTicketsError('');
    try {
      const response = await apiFetch('/api/escalations/mine?page=1&pageSize=50', { credentials: 'same-origin' });
      const result = await response.json() as { tickets?: TicketSummary[]; error?: string };
      if (!response.ok) throw new Error(result.error || 'Your requests are temporarily unavailable.');
      setTickets(Array.isArray(result.tickets) ? result.tickets : []);
    } catch (cause) {
      setTicketsError(cause instanceof Error ? cause.message : 'Your requests are temporarily unavailable.');
    } finally {
      setLoadingTickets(false);
    }
  };

  useEffect(() => {
    if (authenticated) void loadTickets();
  }, [authenticated]);

  const openTicket = async (ticketId: string) => {
    setSelectedTicket(null);
    setTicketsError('');
    try {
      const response = await apiFetch(`/api/escalations/mine/${encodeURIComponent(ticketId)}`, { credentials: 'same-origin' });
      const result = await response.json() as { ticket?: TicketSummary; error?: string };
      if (!response.ok || !result.ticket) throw new Error(result.error || 'Ticket details are unavailable.');
      setSelectedTicket(result.ticket);
    } catch (cause) {
      setTicketsError(cause instanceof Error ? cause.message : 'Ticket details are unavailable.');
    }
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setCreatedTicket(null);
    if (!consented) {
      setError('Consent is required before this request can be submitted.');
      return;
    }
    if (subject.trim().length < 5 || subject.trim().length > 120) {
      setError('Use a subject between 5 and 120 characters.');
      return;
    }
    if (description.trim().length < 10 || description.trim().length > 10_000) {
      setError('Use a description between 10 and 10000 characters.');
      return;
    }

    setSubmitting(true);
    try {
      const response = await apiFetch('/api/escalations', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey.current },
        body: JSON.stringify({
          subject: subject.trim(),
          description: description.trim(),
          ...(category ? { category } : {}),
          ...(conversationId ? { conversationId } : {}),
          consent: { accepted: true, version: ESCALATION_CONSENT_VERSION },
        }),
      });
      const result = await response.json() as { ticket?: TicketSummary; error?: string };
      if (!response.ok || !result.ticket) throw new Error(result.error || 'The request was not submitted. Retry with the same form.');
      setCreatedTicket(result.ticket);
      setSubject('');
      setDescription('');
      setCategory('');
      setConsented(false);
      idempotencyKey.current = crypto.randomUUID();
      await loadTickets();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request was not submitted. Retry with the same form.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-[#0B1220]">
      <header className="flex min-h-14 items-center justify-between gap-3 border-b border-white/[0.08] px-4 py-2.5 lg:px-6 shrink-0">
        <div className="flex items-center gap-3">
          <button type="button" onClick={onOpenMobileSidebar} aria-label="Open navigation sidebar" className="rounded-lg border border-white/[0.08] bg-[#111827] p-2 text-[#F8FAFC] hover:bg-[#1E293B] md:hidden">
            <Menu className="h-4 w-4" aria-hidden="true" />
          </button>
          <div>
            <h1 className="font-display text-lg font-semibold text-[#F8FAFC]">Human Support & Escalation</h1>
            <p className="text-xs text-[#94A3B8]">Submit a private support request and track its status.</p>
          </div>
        </div>
        {showHrEscalations && <button type="button" onClick={onOpenHrEscalations} className="inline-flex items-center gap-2 rounded-lg border border-white/[0.1] bg-[#111827] px-3 py-2 text-xs font-medium text-[#F8FAFC] hover:bg-[#1E293B]"><Inbox className="h-4 w-4" aria-hidden="true" />HR queue</button>}
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6 lg:px-8">
        <div className="mx-auto max-w-[920px] space-y-5">
          {!authenticated ? (
            <section role="status" className="rounded-xl border border-[#F59E0B]/35 bg-[#111827] p-5 text-sm text-[#FDE68A]">
              <div className="flex items-start gap-3"><LifeBuoy className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" /><div><h2 className="font-semibold">Sign-in is required</h2><p className="mt-1 text-xs leading-relaxed">{authMessage || 'A verified account is required to submit or track an HR escalation. No ticket has been created.'}</p><p className="mt-2 text-xs">This environment does not provide a sign-in flow. Ask the project identity administrator to configure the approved authentication integration.</p></div></div>
            </section>
          ) : (
            <>
              <div role="tablist" aria-label="Escalation views" className="flex gap-2">
                <button type="button" role="tab" aria-selected={view === 'new'} onClick={() => setView('new')} className={`rounded-lg px-3 py-2 text-xs font-medium ${view === 'new' ? 'bg-[#2563EB] text-white' : 'bg-[#111827] text-[#CBD5E1]'}`}>New request</button>
                <button type="button" role="tab" aria-selected={view === 'mine'} onClick={() => { setView('mine'); void loadTickets(); }} className={`rounded-lg px-3 py-2 text-xs font-medium ${view === 'mine' ? 'bg-[#2563EB] text-white' : 'bg-[#111827] text-[#CBD5E1]'}`}>My requests</button>
              </div>

              {view === 'new' ? (
                <section className="rounded-xl border border-white/[0.08] bg-[#111827] p-5">
                  <h2 className="font-display text-base font-semibold text-[#F8FAFC]">Request help from authorised support staff</h2>
                  <p className="mt-1 text-xs text-[#94A3B8]">Only include details needed to understand the issue. Do not include passwords, OTPs, payment information, or session tokens.</p>
                  <form onSubmit={submit} className="mt-5 space-y-4">
                    <div className="space-y-1.5"><label htmlFor="escalation-subject" className="block text-xs font-medium text-[#CBD5E1]">Subject</label><input id="escalation-subject" required minLength={5} maxLength={120} value={subject} onChange={(event) => setSubject(event.target.value)} className="w-full rounded-lg border border-white/[0.1] bg-[#0B1220] px-3 py-2 text-sm text-[#F8FAFC] focus:border-[#2563EB] focus:outline-none focus:ring-2 focus:ring-[#2563EB]/30" /></div>
                    <div className="space-y-1.5"><label htmlFor="escalation-category" className="block text-xs font-medium text-[#CBD5E1]">Category (optional)</label><select id="escalation-category" value={category} onChange={(event) => setCategory(event.target.value)} className="w-full rounded-lg border border-white/[0.1] bg-[#0B1220] px-3 py-2 text-sm text-[#F8FAFC] focus:border-[#2563EB] focus:outline-none"><option value="">Choose a category</option>{Object.values(EscalationCategory).map((item) => <option key={item} value={item}>{item}</option>)}</select></div>
                    <div className="space-y-1.5"><label htmlFor="escalation-description" className="block text-xs font-medium text-[#CBD5E1]">What do you need help with?</label><textarea id="escalation-description" required minLength={10} maxLength={10000} rows={6} value={description} onChange={(event) => setDescription(event.target.value)} className="w-full resize-y rounded-lg border border-white/[0.1] bg-[#0B1220] p-3 text-sm leading-relaxed text-[#F8FAFC] focus:border-[#2563EB] focus:outline-none focus:ring-2 focus:ring-[#2563EB]/30" /><p className="text-right text-[11px] text-[#94A3B8]">{description.length}/10000</p></div>
                    {conversationId && <p className="text-xs text-[#94A3B8]">This request will include a reference to the current conversation if it is owned by your account. The transcript is not copied into the ticket.</p>}
                    <label className="flex items-start gap-2 rounded-lg border border-white/[0.08] bg-[#0B1220] p-3 text-xs leading-relaxed text-[#CBD5E1]"><input type="checkbox" checked={consented} onChange={(event) => setConsented(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-[#2563EB]" /><span>{ESCALATION_CONSENT_TEXT}<span className="mt-1 block font-mono text-[10px] text-[#94A3B8]">Consent wording version: {ESCALATION_CONSENT_VERSION}</span></span></label>
                    {error && <p role="alert" className="text-xs text-[#FCA5A5]">{error}</p>}
                    {createdTicket && <div role="status" className="rounded-lg border border-[#10B981]/35 bg-[#052E2B] p-3 text-sm text-[#A7F3D0]"><div className="flex items-center gap-2 font-semibold"><TicketCheck className="h-4 w-4" aria-hidden="true" />Request created</div><p className="mt-1 text-xs">Ticket reference: <span className="font-mono">{createdTicket.reference}</span>. Current status: {createdTicket.status}. No response time has been promised.</p></div>}
                    <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-[11px] text-[#94A3B8]">Audience preference: {audience}. It is not used as identity or permission data.</span><button type="submit" disabled={submitting || !consented} className="inline-flex items-center gap-2 rounded-lg bg-[#2563EB] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1D4ED8] disabled:cursor-not-allowed disabled:opacity-50"><Send className="h-3.5 w-3.5" aria-hidden="true" />{submitting ? 'Submitting…' : 'Submit support request'}</button></div>
                  </form>
                </section>
              ) : (
                <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
                  <div className="rounded-xl border border-white/[0.08] bg-[#111827] p-4"><div className="mb-3 flex items-center justify-between"><h2 className="font-semibold text-[#F8FAFC]">My support requests</h2><button type="button" onClick={() => void loadTickets()} className="text-xs text-[#93C5FD] hover:underline">Refresh</button></div>{loadingTickets ? <p role="status" className="text-xs text-[#94A3B8]">Loading requests…</p> : tickets.length === 0 ? <p className="text-xs text-[#94A3B8]">No requests found.</p> : <ul className="space-y-2">{tickets.map((ticket) => <li key={ticket.id}><button type="button" onClick={() => void openTicket(ticket.id)} className="w-full rounded-lg border border-white/[0.08] p-3 text-left hover:bg-white/[0.04]"><span className="block font-mono text-xs text-[#93C5FD]">{ticket.reference}</span><span className="mt-1 block truncate text-sm text-[#F8FAFC]">{ticket.subject}</span><span className="mt-1 block text-[11px] text-[#94A3B8]">{ticket.status.replace('_', ' ')} · updated {formatDate(ticket.updatedAt)}</span></button></li>)}</ul>}</div>
                  <div className="rounded-xl border border-white/[0.08] bg-[#111827] p-4">{selectedTicket ? <><h2 className="font-mono text-sm font-semibold text-[#93C5FD]">{selectedTicket.reference}</h2><p className="mt-2 text-sm font-medium text-[#F8FAFC]">{selectedTicket.subject}</p><p className="mt-1 text-xs text-[#94A3B8]">Status: {selectedTicket.status.replace('_', ' ')} · Created {formatDate(selectedTicket.createdAt)}</p>{selectedTicket.category && <p className="mt-3 text-xs text-[#CBD5E1]">{selectedTicket.category}</p>}<p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-[#CBD5E1]">{selectedTicket.description}</p><h3 className="mt-5 text-xs font-semibold text-[#CBD5E1]">Status history</h3><ol className="mt-2 space-y-2">{selectedTicket.statusHistory.map((item, index) => <li key={`${item.to}-${item.changedAt}-${index}`} className="text-xs text-[#94A3B8]">{item.to.replace('_', ' ')} · {formatDate(item.changedAt)}</li>)}</ol><p className="mt-4 text-[11px] text-[#64748B]">Internal staff notes are not available in requester details.</p></> : <p className="text-xs text-[#94A3B8]">Select one of your requests to view its details.</p>}</div>
                </section>
              )}
              {ticketsError && <p role="alert" className="text-xs text-[#FCA5A5]">{ticketsError}</p>}
            </>
          )}
        </div>
      </div>
    </main>
  );
}
