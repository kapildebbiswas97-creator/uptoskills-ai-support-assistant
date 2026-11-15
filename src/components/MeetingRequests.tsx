import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarDays, Menu, Plus, Send, TicketCheck, Trash2 } from 'lucide-react';
import { browserTimeZone, validateMeetingDraft, type MeetingTimeDraft } from '../utils/meetingRequest';
import { apiFetch } from '../utils/apiClient';

type Status = 'pending' | 'confirmed' | 'rejected' | 'cancelled';
interface MeetingRequest {
  id: string; reference: string; subject: string; purpose: string; conversationId: string | null;
  preferredTimes: Array<{ startAt: string; endAt: string }>; timeZone: string; status: Status; version: number;
  createdAt: string; updatedAt: string; statusHistory: Array<{ from: Status | null; to: Status; at: string }>;
  confirmation: null | { startAt: string; endAt: string; timeZone: string; location: string | null; confirmedAt: string };
  rejectionReason: string | null;
}

function dateText(value: string, timeZone?: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
  try { return date.toLocaleString(undefined, timeZone ? { timeZone } : undefined); } catch { return date.toLocaleString(); }
}
function statusText(status: Status) { return status.replace('_', ' '); }

export function MeetingRequests({ authenticated, authMessage, conversationId, onOpenMobileSidebar }: {
  authenticated: boolean; authMessage: string; conversationId?: string | null; onOpenMobileSidebar: () => void;
}) {
  const [subject, setSubject] = useState('');
  const [purpose, setPurpose] = useState('');
  const [timeZone, setTimeZone] = useState(browserTimeZone);
  const [options, setOptions] = useState<MeetingTimeDraft[]>([{ startAt: '', endAt: '' }]);
  const [requests, setRequests] = useState<MeetingRequest[]>([]);
  const [selected, setSelected] = useState<MeetingRequest | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const idempotencyKey = useRef(crypto.randomUUID());

  const loadMine = useCallback(async () => {
    if (!authenticated) return;
    setLoading(true); setError('');
    try {
      const response = await apiFetch('/api/meeting-requests/mine?page=1&pageSize=50', { credentials: 'same-origin' });
      const body = await response.json() as { requests?: MeetingRequest[]; error?: string };
      if (!response.ok) throw new Error(body.error || 'Meeting requests could not be loaded.');
      setRequests(Array.isArray(body.requests) ? body.requests : []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Meeting requests could not be loaded.'); }
    finally { setLoading(false); }
  }, [authenticated]);
  useEffect(() => { void loadMine(); }, [loadMine]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError(''); setSuccess(''); setSelected(null);
    const invalid = validateMeetingDraft(subject, purpose, timeZone, options);
    if (invalid) { setError(invalid); return; }
    setSubmitting(true);
    try {
      const response = await apiFetch('/api/meeting-requests', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey.current },
        body: JSON.stringify({ subject: subject.trim(), purpose: purpose.trim(), preferredTimes: options.map(({ startAt, endAt }) => ({ startAt: new Date(startAt).toISOString(), endAt: new Date(endAt).toISOString() })), timeZone, ...(conversationId ? { conversationId } : {}) }),
      });
      const body = await response.json() as { request?: MeetingRequest; error?: string };
      if (!response.ok || !body.request) throw new Error(body.error || 'Your request was not submitted. Retry using the same form.');
      setSelected(body.request); setSuccess(`Request saved as ${body.request.reference}. It is pending HR review; no meeting has been confirmed.`);
      setSubject(''); setPurpose(''); setOptions([{ startAt: '', endAt: '' }]); idempotencyKey.current = crypto.randomUUID();
      await loadMine();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Your request was not submitted. Retry using the same form.'); }
    finally { setSubmitting(false); }
  };

  const openRequest = async (id: string) => {
    setSelected(null); setError(''); setSuccess('');
    try {
      const response = await apiFetch(`/api/meeting-requests/mine/${encodeURIComponent(id)}`, { credentials: 'same-origin' });
      const body = await response.json() as { request?: MeetingRequest; error?: string };
      if (!response.ok || !body.request) throw new Error(body.error || 'Request details are unavailable.');
      setSelected(body.request);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Request details are unavailable.'); }
  };

  const cancelRequest = async () => {
    if (!selected || selected.status !== 'pending') return;
    setError(''); setSuccess('');
    try {
      const response = await apiFetch(`/api/meeting-requests/mine/${encodeURIComponent(selected.id)}/cancel`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: selected.version }) });
      const body = await response.json() as { request?: MeetingRequest; error?: string };
      if (!response.ok || !body.request) throw new Error(body.error || 'Cancellation was not saved.');
      setSelected(body.request); setSuccess('Request cancelled.'); await loadMine();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Cancellation was not saved.'); }
  };

  return <main className="flex min-w-0 flex-1 flex-col bg-[#0B1220]">
    <header className="flex min-h-14 items-center gap-3 border-b border-white/[0.08] px-4 py-2.5 lg:px-6"><button type="button" onClick={onOpenMobileSidebar} aria-label="Open navigation sidebar" className="rounded-lg border border-white/[0.08] bg-[#111827] p-2 text-[#F8FAFC] md:hidden"><Menu className="h-4 w-4" aria-hidden="true" /></button><div><h1 className="flex items-center gap-2 font-display text-lg font-semibold text-[#F8FAFC]"><CalendarDays className="h-5 w-5 text-[#93C5FD]" aria-hidden="true" />Meeting requests</h1><p className="text-xs text-[#94A3B8]">Requests stay pending until HR confirms an actual time.</p></div></header>
    <div className="flex-1 overflow-y-auto px-4 py-6 lg:px-8"><div className="mx-auto max-w-[1100px] space-y-4">
      {!authenticated ? <section role="status" className="rounded-xl border border-[#F59E0B]/30 bg-[#111827] p-5 text-sm text-[#FDE68A]"><h2 className="font-semibold">Verified sign-in is required</h2><p className="mt-2 text-xs leading-relaxed">{authMessage || 'No request has been submitted. This environment does not provide a browser sign-in flow.'}</p></section> : <>
        {error && <p role="alert" className="rounded-lg border border-[#EF4444]/30 bg-[#450A0A]/40 p-3 text-xs text-[#FCA5A5]">{error}</p>}
        {success && <p role="status" className="rounded-lg border border-[#10B981]/30 bg-[#052E2B] p-3 text-xs text-[#A7F3D0]">{success}</p>}
        <section className="rounded-xl border border-white/[0.08] bg-[#111827] p-4 sm:p-5">
          <h2 className="font-semibold text-[#F8FAFC]">Request a meeting</h2><p className="mt-1 text-xs text-[#94A3B8]">Give one to three preferred time ranges. Use an ISO 8601 timestamp with a UTC offset; local times without an offset are not accepted.</p>
          <form onSubmit={submit} className="mt-4 space-y-4">
            <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1.5 text-xs text-[#CBD5E1]">Subject<input required minLength={5} maxLength={120} value={subject} onChange={(e) => setSubject(e.target.value)} className="mt-1 block w-full rounded-lg border border-white/[0.1] bg-[#0B1220] px-3 py-2 text-sm text-white" /></label><label className="space-y-1.5 text-xs text-[#CBD5E1]">IANA time zone<input required maxLength={100} value={timeZone} onChange={(e) => setTimeZone(e.target.value)} placeholder="Asia/Kolkata" className="mt-1 block w-full rounded-lg border border-white/[0.1] bg-[#0B1220] px-3 py-2 text-sm text-white" /></label></div>
            <label className="block space-y-1.5 text-xs text-[#CBD5E1]">Purpose<textarea required minLength={10} maxLength={2000} rows={3} value={purpose} onChange={(e) => setPurpose(e.target.value)} className="mt-1 block w-full rounded-lg border border-white/[0.1] bg-[#0B1220] p-3 text-sm text-white" /></label>
            <fieldset className="space-y-3"><legend className="text-xs font-semibold text-[#CBD5E1]">Preferred time ranges</legend>{options.map((option, index) => <div key={index} className="grid gap-2 rounded-lg border border-white/[0.07] p-3 sm:grid-cols-[1fr_1fr_auto]"><label className="text-xs text-[#CBD5E1]">Start (ISO 8601 with offset)<input required type="text" inputMode="text" placeholder="2026-12-01T09:00:00+05:30" value={option.startAt} onChange={(e) => setOptions((current) => current.map((item, i) => i === index ? { ...item, startAt: e.target.value } : item))} className="mt-1 block w-full rounded border border-white/[0.1] bg-[#0B1220] px-2 py-2 text-xs text-white" /></label><label className="text-xs text-[#CBD5E1]">End (ISO 8601 with offset)<input required type="text" placeholder="2026-12-01T09:30:00+05:30" value={option.endAt} onChange={(e) => setOptions((current) => current.map((item, i) => i === index ? { ...item, endAt: e.target.value } : item))} className="mt-1 block w-full rounded border border-white/[0.1] bg-[#0B1220] px-2 py-2 text-xs text-white" /></label>{options.length > 1 && <button type="button" aria-label={`Remove time option ${index + 1}`} onClick={() => setOptions((current) => current.filter((_, i) => i !== index))} className="self-end rounded p-2 text-[#FCA5A5] hover:bg-white/[0.05]"><Trash2 className="h-4 w-4" aria-hidden="true" /></button>}</div>)}{options.length < 3 && <button type="button" onClick={() => setOptions((current) => [...current, { startAt: '', endAt: '' }])} className="inline-flex items-center gap-1 text-xs text-[#93C5FD] hover:underline"><Plus className="h-3.5 w-3.5" aria-hidden="true" />Add another option</button>}</fieldset>
            {conversationId && <p className="text-[11px] text-[#94A3B8]">The current conversation reference may be included if it belongs to your verified account. Its transcript is not copied.</p>}
            <div className="flex justify-end"><button type="submit" disabled={submitting} className="inline-flex items-center gap-2 rounded-lg bg-[#2563EB] px-4 py-2 text-xs font-semibold text-white disabled:opacity-50"><Send className="h-3.5 w-3.5" aria-hidden="true" />{submitting ? 'Submitting…' : 'Submit request'}</button></div>
          </form>
        </section>
        <section className="grid gap-4 lg:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.2fr)]"><div className="rounded-xl border border-white/[0.08] bg-[#111827] p-4"><div className="mb-3 flex items-center justify-between"><h2 className="font-semibold text-[#F8FAFC]">My requests</h2><button type="button" onClick={() => void loadMine()} disabled={loading} className="text-xs text-[#93C5FD] hover:underline disabled:opacity-50">Refresh</button></div>{loading ? <p role="status" className="text-xs text-[#94A3B8]">Loading requests…</p> : requests.length === 0 ? <p className="text-xs text-[#94A3B8]">No meeting requests yet.</p> : <ul className="space-y-2">{requests.map((item) => <li key={item.id}><button type="button" onClick={() => void openRequest(item.id)} className="w-full rounded-lg border border-white/[0.08] p-3 text-left hover:bg-white/[0.04]"><span className="block font-mono text-xs text-[#93C5FD]">{item.reference}</span><span className="mt-1 block text-sm text-[#F8FAFC]">{item.subject}</span><span className="mt-1 block text-[11px] capitalize text-[#94A3B8]">{statusText(item.status)}</span></button></li>)}</ul>}</div>
          <div className="rounded-xl border border-white/[0.08] bg-[#111827] p-4">{selected ? <><h2 className="font-mono text-sm font-semibold text-[#93C5FD]">{selected.reference}</h2><p className="mt-1 font-semibold text-[#F8FAFC]">{selected.subject}</p><p className="mt-1 text-xs capitalize text-[#94A3B8]">Status: {statusText(selected.status)}</p><p className="mt-3 whitespace-pre-wrap text-sm text-[#CBD5E1]">{selected.purpose}</p><p className="mt-3 text-xs text-[#94A3B8]">Time zone: {selected.timeZone}</p><h3 className="mt-4 text-xs font-semibold text-[#CBD5E1]">Your preferred times</h3><ul className="mt-2 space-y-1 text-xs text-[#94A3B8]">{selected.preferredTimes.map((time, index) => <li key={index}>{dateText(time.startAt, selected.timeZone)} – {dateText(time.endAt, selected.timeZone)}</li>)}</ul>{selected.status === 'confirmed' && selected.confirmation && <div className="mt-4 rounded-lg border border-[#10B981]/30 bg-[#052E2B] p-3"><h3 className="flex items-center gap-2 text-sm font-semibold text-[#A7F3D0]"><TicketCheck className="h-4 w-4" aria-hidden="true" />Confirmed by HR</h3><p className="mt-2 text-xs text-[#D1FAE5]">{dateText(selected.confirmation.startAt, selected.confirmation.timeZone)} – {dateText(selected.confirmation.endAt, selected.confirmation.timeZone)} ({selected.confirmation.timeZone})</p>{selected.confirmation.location && <p className="mt-1 text-xs text-[#D1FAE5]">{selected.confirmation.location}</p>}</div>}{selected.status === 'rejected' && selected.rejectionReason && <p className="mt-4 rounded-lg border border-[#F59E0B]/20 p-3 text-xs text-[#FDE68A]">HR response: {selected.rejectionReason}</p>}<h3 className="mt-4 text-xs font-semibold text-[#CBD5E1]">Status history</h3><ol className="mt-2 space-y-1 text-xs text-[#94A3B8]">{selected.statusHistory.map((event, index) => <li key={index} className="capitalize">{statusText(event.to)} · {dateText(event.at)}</li>)}</ol>{selected.status === 'pending' && <button type="button" onClick={() => void cancelRequest()} className="mt-4 rounded-lg border border-white/[0.1] px-3 py-2 text-xs text-[#FCA5A5] hover:bg-white/[0.04]">Cancel pending request</button>}</> : <p className="text-xs text-[#94A3B8]">Select a request to see its current status and details.</p>}</div>
        </section>
      </>}
    </div></div>
  </main>;
}
