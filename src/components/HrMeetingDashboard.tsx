import { useCallback, useEffect, useState } from 'react';
import { CalendarCheck2, Menu, RefreshCw } from 'lucide-react';
import { browserTimeZone, validateConfirmationDraft } from '../utils/meetingRequest';

type Status = 'pending' | 'confirmed' | 'rejected' | 'cancelled';
interface HrRequest {
  id: string; reference: string; subject: string; purpose: string; requesterId: string; tenantId: string | null;
  conversationId: string | null; preferredTimes: Array<{ startAt: string; endAt: string }>; timeZone: string;
  status: Status; version: number; createdAt: string; rejectionReason: string | null;
  statusHistory: Array<{ from: Status | null; to: Status; actorId?: string; actorRole?: string; at: string }>;
  confirmation: null | { startAt: string; endAt: string; timeZone: string; location?: string; confirmedAt: string; confirmedBy: string; source: 'hr_manual' };
}
function dateText(value: string, zone?: string) { const d = new Date(value); if (Number.isNaN(d.getTime())) return 'Date unavailable'; try { return d.toLocaleString(undefined, zone ? { timeZone: zone } : undefined); } catch { return d.toLocaleString(); } }

export function HrMeetingDashboard({ onOpenMobileSidebar }: { onOpenMobileSidebar: () => void }) {
  const [status, setStatus] = useState('pending'); const [page, setPage] = useState(1);
  const [requests, setRequests] = useState<HrRequest[]>([]); const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<HrRequest | null>(null); const [loading, setLoading] = useState(false); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [startAt, setStartAt] = useState(''); const [endAt, setEndAt] = useState(''); const [timeZone, setTimeZone] = useState(browserTimeZone); const [location, setLocation] = useState(''); const [reason, setReason] = useState('');

  const loadQueue = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const query = new URLSearchParams({ page: String(page), pageSize: '20' }); if (status) query.set('status', status);
      const response = await fetch(`/api/admin/meeting-requests?${query}`, { credentials: 'same-origin' });
      const body = await response.json() as { requests?: HrRequest[]; pagination?: { total: number }; error?: string };
      if (!response.ok) throw new Error(body.error || 'The authorised meeting queue is unavailable.');
      setRequests(Array.isArray(body.requests) ? body.requests : []); setTotal(body.pagination?.total ?? 0);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The authorised meeting queue is unavailable.'); }
    finally { setLoading(false); }
  }, [page, status]);
  useEffect(() => { void loadQueue(); }, [loadQueue]);

  const open = async (id: string) => {
    setError(''); setMessage(''); setSelected(null);
    try { const response = await fetch(`/api/admin/meeting-requests/${encodeURIComponent(id)}`, { credentials: 'same-origin' }); const body = await response.json() as { request?: HrRequest; error?: string }; if (!response.ok || !body.request) throw new Error(body.error || 'Request details are unavailable.'); setSelected(body.request); setTimeZone(body.request.timeZone); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Request details are unavailable.'); }
  };
  const update = async (action: 'confirm' | 'reject') => {
    if (!selected || selected.status !== 'pending') return;
    setError(''); setMessage('');
    if (action === 'confirm') { const invalid = validateConfirmationDraft(startAt, endAt, timeZone); if (invalid) { setError(invalid); return; } }
    if (action === 'reject' && (reason.trim().length < 3 || reason.trim().length > 1000)) { setError('Provide an explanation between 3 and 1000 characters.'); return; }
    setBusy(true);
    try {
      const body = action === 'confirm'
        ? { expectedVersion: selected.version, startAt, endAt, timeZone, ...(location.trim() ? { location: location.trim() } : {}) }
        : { expectedVersion: selected.version, reason: reason.trim() };
      const response = await fetch(`/api/admin/meeting-requests/${encodeURIComponent(selected.id)}/${action}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json() as { request?: HrRequest; error?: string };
      if (!response.ok || !result.request) throw new Error(result.error || `Request was not ${action === 'confirm' ? 'confirmed' : 'rejected'}.`);
      setSelected(result.request); setMessage(action === 'confirm' ? 'Confirmed as a real HR scheduling decision. No calendar event or invitation was created.' : 'Request rejected. The explanation is visible to the requester.');
      setReason(''); await loadQueue();
    } catch (cause) { const failure = cause instanceof Error ? cause.message : 'The decision was not saved.'; await open(selected.id); setError(failure); }
    finally { setBusy(false); }
  };

  return <main className="flex min-w-0 flex-1 flex-col bg-[#0B1220]">
    <header className="flex min-h-14 items-center justify-between gap-3 border-b border-white/[0.08] px-4 py-2.5 lg:px-6"><div className="flex items-center gap-3"><button type="button" onClick={onOpenMobileSidebar} aria-label="Open navigation sidebar" className="rounded-lg border border-white/[0.08] bg-[#111827] p-2 text-[#F8FAFC] md:hidden"><Menu className="h-4 w-4" aria-hidden="true" /></button><div><h1 className="font-display text-lg font-semibold text-[#F8FAFC]">HR meeting requests</h1><p className="text-xs text-[#94A3B8]">Confirmation records an actual manual scheduling decision. It does not create a calendar event or send an invite.</p></div></div><button type="button" onClick={() => void loadQueue()} disabled={loading} className="inline-flex items-center gap-2 rounded-lg border border-white/[0.1] bg-[#111827] px-3 py-2 text-xs text-white disabled:opacity-50"><RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />Refresh</button></header>
    <div className="flex-1 overflow-y-auto px-4 py-6 lg:px-8"><div className="mx-auto max-w-[1200px] space-y-4">
      {error && <p role="alert" className="rounded-lg border border-[#EF4444]/30 bg-[#450A0A]/40 p-3 text-xs text-[#FCA5A5]">{error}</p>}{message && <p role="status" className="rounded-lg border border-[#10B981]/30 bg-[#052E2B] p-3 text-xs text-[#A7F3D0]">{message}</p>}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-[#111827] p-3"><label htmlFor="meeting-status-filter" className="text-xs text-[#CBD5E1]">Filter requests</label><select id="meeting-status-filter" value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }} className="rounded-lg border border-white/[0.1] bg-[#0B1220] px-3 py-2 text-xs text-white"><option value="">All statuses</option><option value="pending">Pending</option><option value="confirmed">Confirmed</option><option value="rejected">Rejected</option><option value="cancelled">Cancelled</option></select><span className="text-xs text-[#94A3B8]">{total} request{total === 1 ? '' : 's'}</span></div>
      <div className="grid gap-4 xl:grid-cols-[minmax(300px,0.8fr)_minmax(0,1.5fr)]"><section aria-label="Meeting request queue" className="rounded-xl border border-white/[0.08] bg-[#111827] p-3"><h2 className="mb-3 px-1 text-sm font-semibold text-white">Queue</h2>{loading ? <p role="status" className="p-2 text-xs text-[#94A3B8]">Loading requests…</p> : requests.length === 0 ? <p className="p-2 text-xs text-[#94A3B8]">No requests in this view.</p> : <ul className="space-y-2">{requests.map((item) => <li key={item.id}><button type="button" onClick={() => void open(item.id)} aria-current={selected?.id === item.id ? 'true' : undefined} className="w-full rounded-lg border border-white/[0.08] p-3 text-left hover:bg-white/[0.04]"><span className="block font-mono text-xs text-[#93C5FD]">{item.reference}</span><span className="mt-1 block text-sm text-white">{item.subject}</span><span className="mt-1 block text-[11px] capitalize text-[#94A3B8]">{item.status} · {dateText(item.createdAt)}</span></button></li>)}</ul>}<div className="mt-3 flex items-center justify-between border-t border-white/[0.07] pt-3"><button type="button" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)} className="px-2 py-1 text-xs text-[#CBD5E1] disabled:opacity-40">Previous</button><span className="text-[11px] text-[#94A3B8]">Page {page}</span><button type="button" disabled={loading || page * 20 >= total} onClick={() => setPage((p) => p + 1)} className="px-2 py-1 text-xs text-[#CBD5E1] disabled:opacity-40">Next</button></div></section>
        <section aria-label="Meeting request details" className="rounded-xl border border-white/[0.08] bg-[#111827] p-4">{selected ? <><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-mono text-xs text-[#93C5FD]">{selected.reference}</p><h2 className="mt-1 text-base font-semibold text-white">{selected.subject}</h2><p className="mt-1 text-xs capitalize text-[#94A3B8]">{selected.status}</p></div><div className="text-right text-[11px] text-[#94A3B8]">Requester: <span className="font-mono">{selected.requesterId}</span><br />Tenant: <span className="font-mono">{selected.tenantId || 'none'}</span></div></div><p className="mt-4 whitespace-pre-wrap text-sm text-[#CBD5E1]">{selected.purpose}</p><p className="mt-3 text-xs text-[#94A3B8]">Requester time zone: {selected.timeZone}</p>{selected.conversationId && <p className="mt-2 break-all text-xs text-[#94A3B8]">Conversation: <span className="font-mono">{selected.conversationId}</span></p>}<h3 className="mt-4 text-xs font-semibold text-[#CBD5E1]">Preferred times</h3><ul className="mt-2 space-y-1 text-xs text-[#94A3B8]">{selected.preferredTimes.map((time, i) => <li key={i}>{dateText(time.startAt, selected.timeZone)} – {dateText(time.endAt, selected.timeZone)}</li>)}</ul>
          {selected.status === 'pending' ? <div className="mt-5 space-y-4 border-t border-white/[0.08] pt-4"><div className="rounded-lg border border-[#F59E0B]/25 bg-[#451A03]/20 p-3 text-xs text-[#FDE68A]">Confirm only after an actual meeting time has been agreed. This action records a manual HR decision; no calendar integration is configured.</div><fieldset className="grid gap-3 sm:grid-cols-2"><legend className="mb-2 text-xs font-semibold text-white">Actual confirmed details</legend><label className="text-xs text-[#CBD5E1]">Start (ISO 8601 with offset)<input value={startAt} onChange={(e) => setStartAt(e.target.value)} placeholder="2026-12-01T09:00:00+05:30" className="mt-1 block w-full rounded border border-white/[0.1] bg-[#0B1220] px-2 py-2 text-xs text-white" /></label><label className="text-xs text-[#CBD5E1]">End (ISO 8601 with offset)<input value={endAt} onChange={(e) => setEndAt(e.target.value)} placeholder="2026-12-01T09:30:00+05:30" className="mt-1 block w-full rounded border border-white/[0.1] bg-[#0B1220] px-2 py-2 text-xs text-white" /></label><label className="text-xs text-[#CBD5E1]">IANA time zone<input value={timeZone} onChange={(e) => setTimeZone(e.target.value)} className="mt-1 block w-full rounded border border-white/[0.1] bg-[#0B1220] px-2 py-2 text-xs text-white" /></label><label className="text-xs text-[#CBD5E1]">Location or joining detail (only if confirmed)<input maxLength={500} value={location} onChange={(e) => setLocation(e.target.value)} className="mt-1 block w-full rounded border border-white/[0.1] bg-[#0B1220] px-2 py-2 text-xs text-white" /></label></fieldset><button type="button" disabled={busy} onClick={() => void update('confirm')} className="inline-flex items-center gap-2 rounded-lg bg-[#059669] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"><CalendarCheck2 className="h-3.5 w-3.5" aria-hidden="true" />Confirm actual schedule</button><label className="block text-xs text-[#CBD5E1]">Requester-visible rejection explanation<textarea maxLength={1000} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className="mt-1 block w-full rounded border border-white/[0.1] bg-[#0B1220] p-2 text-xs text-white" /></label><button type="button" disabled={busy} onClick={() => void update('reject')} className="rounded-lg border border-[#FCA5A5]/30 px-3 py-2 text-xs text-[#FCA5A5] disabled:opacity-50">Reject request</button></div> : selected.confirmation && <div className="mt-4 rounded-lg border border-[#10B981]/30 bg-[#052E2B] p-3 text-xs text-[#D1FAE5]">Confirmed schedule: {dateText(selected.confirmation.startAt, selected.confirmation.timeZone)} – {dateText(selected.confirmation.endAt, selected.confirmation.timeZone)} ({selected.confirmation.timeZone}). Confirmed by {selected.confirmation.confirmedBy}; source {selected.confirmation.source}.</div>}
          {selected.statusHistory.length > 0 && <><h3 className="mt-5 text-xs font-semibold text-[#CBD5E1]">Status history</h3><ol className="mt-2 space-y-1 text-xs text-[#94A3B8]">{selected.statusHistory.map((item, i) => <li key={i} className="capitalize">{item.from ? `${item.from} → ` : ''}{item.to} · {dateText(item.at)}{item.actorRole ? ` · ${item.actorRole}` : ''}</li>)}</ol></>}
        </> : <p className="text-xs text-[#94A3B8]">Select a request to review its details.</p>}</section>
      </div>
    </div></div>
  </main>;
}
