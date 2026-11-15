export interface MeetingTimeDraft { startAt: string; endAt: string }

const ISO_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|([+-])(\d{2}):(\d{2}))$/i;

export function parseExplicitMeetingInstant(value: string): number | undefined {
  const match = ISO_OFFSET.exec(value);
  if (!match) return undefined;
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw = '0', zone, , offsetHourRaw, offsetMinuteRaw] = match;
  const year = Number(yearRaw), month = Number(monthRaw), day = Number(dayRaw);
  const hour = Number(hourRaw), minute = Number(minuteRaw), second = Number(secondRaw);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > days || hour > 23 || minute > 59 || second > 59) return undefined;
  if (zone.toUpperCase() !== 'Z' && (Number(offsetHourRaw) > 14 || Number(offsetMinuteRaw) > 59 || (Number(offsetHourRaw) === 14 && Number(offsetMinuteRaw) !== 0))) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export function isValidMeetingTimeZone(value: string): boolean {
  if (!value || value.length > 100 || /[\x00-\x20]/.test(value)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0); return true; } catch { return false; }
}

export function validateMeetingDraft(subject: string, purpose: string, timeZone: string, preferredTimes: MeetingTimeDraft[], now = Date.now()): string | undefined {
  if (subject.trim().length < 5 || subject.trim().length > 120) return 'Subject must be between 5 and 120 characters.';
  if (purpose.trim().length < 10 || purpose.trim().length > 2000) return 'Purpose must be between 10 and 2000 characters.';
  if (!isValidMeetingTimeZone(timeZone)) return 'Enter a valid IANA time zone, such as Asia/Kolkata.';
  if (preferredTimes.length < 1 || preferredTimes.length > 3) return 'Provide between one and three preferred time ranges.';
  for (const [index, option] of preferredTimes.entries()) {
    const startAt = parseExplicitMeetingInstant(option.startAt), endAt = parseExplicitMeetingInstant(option.endAt);
    if (startAt === undefined || endAt === undefined) return `Time option ${index + 1} must use ISO 8601 with an explicit UTC offset.`;
    if (startAt <= now) return `Time option ${index + 1} must be in the future.`;
    if (endAt <= startAt) return `Time option ${index + 1} must end after it starts.`;
  }
  return undefined;
}

export function validateConfirmationDraft(startAt: string, endAt: string, timeZone: string, now = Date.now()): string | undefined {
  if (!isValidMeetingTimeZone(timeZone)) return 'Enter a valid IANA time zone.';
  const start = parseExplicitMeetingInstant(startAt), end = parseExplicitMeetingInstant(endAt);
  if (start === undefined || end === undefined) return 'Use ISO 8601 date-time values with an explicit UTC offset.';
  if (start <= now) return 'The actual meeting time must be in the future.';
  if (end <= start) return 'End time must be later than start time.';
  return undefined;
}

export function browserTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}
