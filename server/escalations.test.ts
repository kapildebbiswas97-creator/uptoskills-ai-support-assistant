import test from 'node:test';
import assert from 'node:assert/strict';
import type { Db } from 'mongodb';
import type { AuthenticatedPrincipal } from './auth';
import {
  EscalationServiceError,
  MongoEscalationService,
  escalationRequestHash,
  isValidStatusTransition,
  validateEscalationCreateInput,
  validateIdempotencyKey,
} from './escalations';
import { ESCALATION_CONSENT_VERSION } from '../src/utils/escalationConsent';

const validInput = {
  subject: 'Help with my application',
  description: 'I need help understanding the next step in my application.',
  consent: { accepted: true, version: ESCALATION_CONSENT_VERSION },
};

test('escalation input requires explicit versioned consent and trims bounded text', () => {
  const input = validateEscalationCreateInput({ ...validInput, subject: '  Help with my application  ' });
  assert.equal(input.subject, 'Help with my application');
  assert.equal(input.consent.accepted, true);
  assert.throws(() => validateEscalationCreateInput({ ...validInput, consent: { accepted: false, version: ESCALATION_CONSENT_VERSION } }), (error: unknown) => error instanceof EscalationServiceError && error.code === 'CONSENT_REQUIRED');
  assert.throws(() => validateEscalationCreateInput({ ...validInput, consent: { accepted: true, version: 'old-version' } }), (error: unknown) => error instanceof EscalationServiceError && error.code === 'CONSENT_REQUIRED');
});

test('escalation input rejects identity, tenant, status, and internal-note fields from clients', () => {
  for (const forbidden of [
    { requesterId: 'attacker' }, { tenantId: 'other-tenant' }, { status: 'resolved' }, { roles: ['support_agent'] }, { internalNotes: ['private'] },
  ]) {
    assert.throws(() => validateEscalationCreateInput({ ...validInput, ...forbidden }), (error: unknown) => error instanceof EscalationServiceError && error.code === 'INVALID_REQUEST');
  }
});

test('escalation input rejects NoSQL objects and invalid category or conversation IDs', () => {
  assert.throws(() => validateEscalationCreateInput({ ...validInput, subject: { $ne: '' } }), /INVALID_SUBJECT/);
  assert.throws(() => validateEscalationCreateInput({ ...validInput, category: 'unlisted' }), /INVALID_CATEGORY/);
  assert.throws(() => validateEscalationCreateInput({ ...validInput, conversationId: { $ne: '' } }), /INVALID_CONVERSATION/);
});

test('idempotency keys must be bounded URL-safe opaque values', () => {
  assert.equal(validateIdempotencyKey('valid_retry_key_123'), 'valid_retry_key_123');
  for (const key of [undefined, '', 'short', 'bad key with spaces', 'x'.repeat(129)]) {
    assert.throws(() => validateIdempotencyKey(key), /IDEMPOTENCY_KEY_REQUIRED/);
  }
});

test('idempotency fingerprint binds all materially relevant request fields', () => {
  const base = validateEscalationCreateInput(validInput);
  assert.equal(escalationRequestHash(base), escalationRequestHash(validateEscalationCreateInput({ ...validInput })));
  assert.notEqual(escalationRequestHash(base), escalationRequestHash(validateEscalationCreateInput({ ...validInput, subject: 'Another valid subject' })));
  assert.notEqual(escalationRequestHash(base), escalationRequestHash(validateEscalationCreateInput({ ...validInput, conversationId: 'conversation-123' })));
});

test('proposed ticket lifecycle permits only forward status transitions', () => {
  assert.equal(isValidStatusTransition('open', 'in_progress'), true);
  assert.equal(isValidStatusTransition('in_progress', 'resolved'), true);
  assert.equal(isValidStatusTransition('resolved', 'closed'), true);
  assert.equal(isValidStatusTransition('open', 'closed'), false);
  assert.equal(isValidStatusTransition('closed', 'open'), false);
  assert.equal(isValidStatusTransition('in_progress', 'open'), false);
});

test('Mongo ticket creation writes its audit event in one transaction and returns the original on retry', async () => {
  const tickets: Array<Record<string, unknown>> = [];
  const auditEvents: Array<Record<string, unknown>> = [];
  let failAudit = true;
  let observedTicketSession: unknown;
  let observedAuditSession: unknown;
  const db = {
    collection(name: string) {
      if (name === 'conversations') return { findOne: async () => null };
      if (name === 'escalations') return {
        findOne: async (filter: Record<string, unknown>) => tickets.find((ticket) => Object.entries(filter).every(([key, value]) => ticket[key] === value)) ?? null,
        insertOne: async (ticket: Record<string, unknown>, options: { session?: unknown }) => { observedTicketSession = options.session; tickets.push(ticket); return { insertedId: ticket._id }; },
      };
      if (name === 'audit_logs') return {
        insertOne: async (event: Record<string, unknown>, options: { session?: unknown }) => {
          observedAuditSession = options.session;
          if (failAudit) throw new Error('audit write failure');
          auditEvents.push(event);
          return { insertedId: 'audit-id' };
        },
      };
      throw new Error(`unexpected collection ${name}`);
    },
  } as unknown as Db;
  const session = {
    async withTransaction<T>(callback: () => Promise<T>) {
      const ticketCount = tickets.length;
      const auditCount = auditEvents.length;
      try {
        return await callback();
      } catch (error) {
        tickets.splice(ticketCount);
        auditEvents.splice(auditCount);
        throw error;
      }
    },
    async endSession() {},
  };
  const service = new MongoEscalationService(async () => db, async () => session as never);
  const principal: AuthenticatedPrincipal = { subject: 'requester-1', roles: ['user'], tenantId: 'tenant-a' };
  const input = validateEscalationCreateInput(validInput);

  await assert.rejects(service.create(principal, input, 'transaction_audit_key_1'), /audit write failure/);
  assert.equal(tickets.length, 0, 'failed audit insert rolls back ticket insert');
  assert.equal(auditEvents.length, 0);
  assert.equal(observedTicketSession, observedAuditSession, 'ticket and audit share the same transaction session');

  failAudit = false;
  const created = await service.create(principal, input, 'transaction_audit_key_1');
  assert.equal(created.duplicate, false);
  assert.equal(tickets.length, 1);
  assert.equal(auditEvents.length, 1);
  assert.equal(auditEvents[0]?.action, 'escalation.created');
  const retry = await service.create(principal, input, 'transaction_audit_key_1');
  assert.equal(retry.duplicate, true);
  assert.equal(retry.ticket.reference, created.ticket.reference);
  assert.equal(tickets.length, 1);
  assert.equal(auditEvents.length, 1, 'a valid retry does not create duplicate ticket or audit action');

  const supportPrincipal: AuthenticatedPrincipal = { subject: 'hr-creator', roles: ['support_agent'], tenantId: 'tenant-a' };
  const hrCreated = await service.create(supportPrincipal, input, 'hr_creator_audit_key_1');
  assert.equal(hrCreated.ticket.statusHistory[0]?.actorRole, 'support_agent');
  assert.equal(auditEvents[1]?.actorRole, 'support_agent');
});
