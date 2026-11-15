import assert from 'node:assert/strict';
import test from 'node:test';
import { parseExplicitMeetingInstant, validateConfirmationDraft, validateMeetingDraft } from './meetingRequest';

const NOW = Date.parse('2026-11-15T00:00:00Z');
const validOption = { startAt: '2026-12-01T09:00:00+05:30', endAt: '2026-12-01T09:30:00+05:30' };

test('meeting request client validation requires valid subject, purpose, IANA zone and explicit-offset times', () => {
  assert.equal(validateMeetingDraft('Discuss my onboarding', 'I would like help reviewing next steps.', 'Asia/Kolkata', [validOption], NOW), undefined);
  assert.match(validateMeetingDraft('Help', 'I would like help reviewing next steps.', 'Asia/Kolkata', [validOption], NOW) ?? '', /Subject/);
  assert.match(validateMeetingDraft('Discuss my onboarding', 'short', 'Asia/Kolkata', [validOption], NOW) ?? '', /Purpose/);
  assert.match(validateMeetingDraft('Discuss my onboarding', 'I would like help reviewing next steps.', 'Mars/Colony', [validOption], NOW) ?? '', /time zone/);
  assert.match(validateMeetingDraft('Discuss my onboarding', 'I would like help reviewing next steps.', 'Asia/Kolkata', [{ ...validOption, startAt: '2026-12-01T09:00:00' }], NOW) ?? '', /explicit UTC offset/);
});

test('meeting time validation rejects impossible, past and reversed date-time ranges', () => {
  assert.equal(parseExplicitMeetingInstant('2026-02-30T09:00:00Z'), undefined);
  assert.match(validateMeetingDraft('Discuss my onboarding', 'I would like help reviewing next steps.', 'UTC', [{ startAt: '2026-10-01T09:00:00Z', endAt: '2026-10-01T10:00:00Z' }], NOW) ?? '', /future/);
  assert.match(validateMeetingDraft('Discuss my onboarding', 'I would like help reviewing next steps.', 'UTC', [{ startAt: validOption.endAt, endAt: validOption.startAt }], NOW) ?? '', /end after/);
  assert.match(validateMeetingDraft('Discuss my onboarding', 'I would like help reviewing next steps.', 'UTC', [validOption, validOption, validOption, validOption], NOW) ?? '', /one and three/);
});

test('HR confirmation validation requires a future real schedule and explicit time zone', () => {
  assert.equal(validateConfirmationDraft(validOption.startAt, validOption.endAt, 'Asia/Kolkata', NOW), undefined);
  assert.match(validateConfirmationDraft('2026-12-01T09:00:00', validOption.endAt, 'Asia/Kolkata', NOW) ?? '', /UTC offset/);
  assert.match(validateConfirmationDraft(validOption.startAt, validOption.endAt, 'invalid-zone', NOW) ?? '', /IANA/);
});
