import { useCallback, useEffect, useState } from 'react';
import { Inbox, Menu, RefreshCw, Send } from 'lucide-react';
import { apiFetch } from '../utils/apiClient';

type Status = 'open' | 'in_progress' | 'resolved' | 'closed';
interface HrTicket {
  id: string;
  reference: string;
  subject: string;
  description: string;
  category: string | null;
  status: Status;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  version: number;
  tenantId: string | null;
  requesterId: string;
  conversationId: string | null;
  consent: { accepted: true; version: string; text: string; at: string };
  statusHistory: Array<{ from: Status | null; to: Status; actorId: string; actorRole: string; changedAt: string }>;
  internalNotes: Array<{ id: string; authorId: string; createdAt: string; content: string }>;
}

const transitions: Record<Status, Status[]> = {
  open: ['in_progress'],
  in_progress: ['resolved'],
  resolved: ['closed'],
  closed: [],
};

function dateText(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleString();
}

export function HrEscalationDashboard({ onOpenMobileSidebar }: { onOpenMobileSidebar: () => void }) {
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [tickets, setTickets] = useState<HrTicket[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<HrTicket | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [note, setNote] = useState('');

  const loadQueue = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams({ page: String(page), pageSize: '20' });
      if (statusFilter) query.set('status', statusFilter);
      const response = await apiFetch(`/api/escalations/admin/escalations?${query}`, { credentials: 'same-origin' });
      const result = await response.json() as { tickets?: HrTicket[]; pagination?: { total: number }; error?: string };
      if (!response.ok) throw new Error(result.error || 'The authorised HR queue is unavailable.');
      setTickets(result.tickets ?? []);
      setTotal(result.pagination?.total ?? 0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The authorised HR queue is unavailable.');
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter]);

  useEffect(() => { void loadQueue(); }, [loadQueue]);

  const openTicket = async (ticketId: string) => {
    setSelected(null);
    setError('');
    setSuccess('');
    try {
      const response = await apiFetch(`/api/escalations/admin/escalations/${encodeURIComponent(ticketId)}`, { credentials: 'same-origin' });
      const result = await response.json() as { ticket?: HrTicket; error?: string };
      if (!response.ok || !result.ticket) throw new Error(result.error || 'Ticket details are unavailable.');
      setSelected(result.ticket);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Ticket details are unavailable.');
    }
  };

  const changeStatus = async (status: Status) => {
    if (!selected) return;
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const response = await apiFetch(`/api/escalations/admin/escalations/${encodeURIComponent(selected.id)}`, {
        method: 'PATCH', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, expectedVersion: selected.version }),
      });
      const result = await response.json() as { ticket?: HrTicket; error?: string };
      if (!response.ok || !result.ticket) throw new Error(result.error || 'Status was not updated.');
      setSelected(result.ticket);
      setSuccess(`Status changed to ${result.ticket.status.replace('_', ' ')}.`);
      await loadQueue();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Status was not updated.');
      await openTicket(selected.id);
    } finally {
      setBusy(false);
    }
  };

  const addNote = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected || !note.trim()) return;
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const response = await apiFetch(`/api/escalations/admin/escalations/${encodeURIComponent(selected.id)}/notes`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: note.trim(), expectedVersion: selected.version }),
      });
      const result = await response.json() as { ticket?: HrTicket; error?: string };
      if (!response.ok || !result.ticket) throw new Error(result.error || 'The internal note was not saved.');
      setSelected(result.ticket);
      setNote('');
      setSuccess('Internal note saved. It is visible only in this authorised HR view.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The internal note was not saved.');
      await openTicket(selected.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-[#0B1220]">
      <header className="flex min-h-14 items-center justify-between gap-3 border-b border-white/[0.08] px-4 py-2.5 lg:px-6 shrink-0">
        <div className="flex items-center gap-3"><button type="button" onClick={onOpenMobileSidebar} aria-label="Open navigation sidebar" className="rounded-lg border border-white/[0.08] bg-[#111827] p-2 text-[#F8FAFC] hover:bg-[#1E293B] md:hidden"><Menu className="h-4 w-4" aria-hidden="true" /></button><div><h1 className="font-display text-lg font-semibold text-[#F8FAFC]">HR Escalation Queue</h1><p className="text-xs text-[#94A3B8]">Access is enforced by the API using the verified support-agent role.</p></div></div>
        <button type="button" onClick={() => void loadQueue()} disabled={loading} className="inline-flex items-center gap-2 rounded-lg border border-white/[0.1] bg-[#111827] px-3 py-2 text-xs text-[#F8FAFC] hover:bg-[#1E293B] disabled:opacity-50"><RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />Refresh</button>
      </header>
      <div className="flex-1 overflow-y-auto px-4 py-6 lg:px-8"><div className="mx-auto max-w-[1200px] space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-[#111827] p-3"><label htmlFor="hr-status-filter" className="text-xs font-medium text-[#CBD5E1]">Filter by status</label><select id="hr-status-filter" value={statusFilter} onChange={(event) => { setPage(1); setStatusFilter(event.target.value); }} className="rounded-lg border border-white/[0.1] bg-[#0B1220] px-3 py-2 text-xs text-[#F8FAFC]"><option value="">All statuses</option><option value="open">Open</option><option value="in_progress">In progress</option><option value="resolved">Resolved</option><option value="closed">Closed</option></select><span className="text-xs text-[#94A3B8]">{total} request{total === 1 ? '' : 's'}</span></div>
        {error && <p role="alert" className="rounded-lg border border-[#EF4444]/30 bg-[#450A0A]/40 p-3 text-xs text-[#FCA5A5]">{error}</p>}
        {success && <p role="status" className="rounded-lg border border-[#10B981]/30 bg-[#052E2B] p-3 text-xs text-[#A7F3D0]">{success}</p>}
        <div className="grid gap-4 xl:grid-cols-[minmax(300px,0.8fr)_minmax(0,1.5fr)]">
          <section aria-label="Escalation queue" className="rounded-xl border border-white/[0.08] bg-[#111827] p-3"><h2 className="mb-3 flex items-center gap-2 px-1 text-sm font-semibold text-[#F8FAFC]"><Inbox className="h-4 w-4" aria-hidden="true" />Requests</h2>{loading ? <p role="status" className="p-2 text-xs text-[#94A3B8]">Loading queue…</p> : tickets.length === 0 ? <p className="p-2 text-xs text-[#94A3B8]">No requests in this view.</p> : <ul className="space-y-2">{tickets.map((ticket) => <li key={ticket.id}><button type="button" onClick={() => void openTicket(ticket.id)} aria-current={selected?.id === ticket.id ? 'true' : undefined} className={`w-full rounded-lg border p-3 text-left ${selected?.id === ticket.id ? 'border-[#2563EB]/60 bg-[#1E293B]' : 'border-white/[0.07] hover:bg-white/[0.04]'}`}><span className="block font-mono text-xs text-[#93C5FD]">{ticket.reference}</span><span className="mt-1 block truncate text-sm text-[#F8FAFC]">{ticket.subject}</span><span className="mt-1 block text-[11px] text-[#94A3B8]">{ticket.status.replace('_', ' ')} · {dateText(ticket.createdAt)}</span></button></li>)}</ul>}
            <div className="mt-3 flex items-center justify-between border-t border-white/[0.07] pt-3"><button type="button" disabled={page <= 1 || loading} onClick={() => setPage((value) => value - 1)} className="rounded-md px-2 py-1 text-xs text-[#CBD5E1] disabled:opacity-40">Previous</button><span className="text-[11px] text-[#94A3B8]">Page {page}</span><button type="button" disabled={loading || page * 20 >= total} onClick={() => setPage((value) => value + 1)} className="rounded-md px-2 py-1 text-xs text-[#CBD5E1] disabled:opacity-40">Next</button></div>
          </section>
          <section aria-label="Escalation details" className="rounded-xl border border-white/[0.08] bg-[#111827] p-4">{selected ? <><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-mono text-xs text-[#93C5FD]">{selected.reference}</p><h2 className="mt-1 text-base font-semibold text-[#F8FAFC]">{selected.subject}</h2><p className="mt-1 text-xs text-[#94A3B8]">{selected.status.replace('_', ' ')} · created {dateText(selected.createdAt)}</p></div><div className="min-w-40"><label htmlFor="hr-status-update" className="mb-1 block text-[11px] text-[#94A3B8]">Change status</label><select id="hr-status-update" value="" disabled={busy || transitions[selected.status].length === 0} onChange={(event) => { if (event.target.value) void changeStatus(event.target.value as Status); }} className="w-full rounded-lg border border-white/[0.1] bg-[#0B1220] px-2.5 py-2 text-xs text-[#F8FAFC] disabled:opacity-50"><option value="">{transitions[selected.status].length ? 'Choose next status' : 'No further transition'}</option>{transitions[selected.status].map((status) => <option key={status} value={status}>{status.replace('_', ' ')}</option>)}</select></div></div>
            <dl className="mt-4 grid gap-2 rounded-lg bg-[#0B1220] p-3 text-xs sm:grid-cols-2"><div><dt className="text-[#94A3B8]">Requester identity</dt><dd className="mt-0.5 break-all font-mono text-[#CBD5E1]">{selected.requesterId}</dd></div><div><dt className="text-[#94A3B8]">Tenant scope</dt><dd className="mt-0.5 break-all font-mono text-[#CBD5E1]">{selected.tenantId || 'No tenant claim'}</dd></div>{selected.category && <div><dt className="text-[#94A3B8]">Category</dt><dd className="mt-0.5 text-[#CBD5E1]">{selected.category}</dd></div>}{selected.conversationId && <div><dt className="text-[#94A3B8]">Conversation reference</dt><dd className="mt-0.5 break-all font-mono text-[#CBD5E1]">{selected.conversationId}</dd></div>}</dl>
            <h3 className="mt-4 text-xs font-semibold text-[#CBD5E1]">Request details</h3><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-[#E2E8F0]">{selected.description}</p>
            <h3 className="mt-5 text-xs font-semibold text-[#CBD5E1]">Status history</h3><ol className="mt-2 space-y-2">{selected.statusHistory.map((item, index) => <li key={`${item.to}-${item.changedAt}-${index}`} className="rounded-md border border-white/[0.06] p-2 text-xs text-[#94A3B8]">{item.from ? `${item.from.replace('_', ' ')} → ` : ''}{item.to.replace('_', ' ')} · {dateText(item.changedAt)} · {item.actorRole}</li>)}</ol>
            <h3 className="mt-5 text-xs font-semibold text-[#CBD5E1]">Internal notes <span className="font-normal text-[#94A3B8]">(authorised support staff only)</span></h3>{selected.internalNotes.length ? <ul className="mt-2 space-y-2">{selected.internalNotes.map((item) => <li key={item.id} className="rounded-md border border-[#F59E0B]/20 bg-[#0B1220] p-3"><p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-[#FDE68A]">{item.content}</p><p className="mt-2 text-[10px] text-[#94A3B8]">{item.authorId} · {dateText(item.createdAt)}</p></li>)}</ul> : <p className="mt-2 text-xs text-[#94A3B8]">No internal notes.</p>}
            <form onSubmit={addNote} className="mt-3 space-y-2"><label htmlFor="hr-internal-note" className="block text-xs text-[#CBD5E1]">Add internal note</label><textarea id="hr-internal-note" maxLength={5000} rows={3} value={note} onChange={(event) => setNote(event.target.value)} className="w-full rounded-lg border border-white/[0.1] bg-[#0B1220] p-3 text-xs text-[#F8FAFC] focus:border-[#2563EB] focus:outline-none" /><div className="flex items-center justify-between"><span className="text-[10px] text-[#64748B]">Up to 5000 characters. Do not copy secrets into notes.</span><button type="submit" disabled={busy || !note.trim()} className="inline-flex items-center gap-2 rounded-lg bg-[#1E293B] px-3 py-2 text-xs font-medium text-[#F8FAFC] disabled:opacity-50"><Send className="h-3 w-3" aria-hidden="true" />Save internal note</button></div></form>
          </> : <p className="text-xs text-[#94A3B8]">Select a request to review its details. Ticket content and notes are returned only to an authorised support-agent identity.</p>}</section>
        </div>
      </div></div>
    </main>
  );
}
