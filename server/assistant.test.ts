import test from 'node:test';
import assert from 'node:assert/strict';
import { AudienceContext, HelpTopicId } from '../src/types/assistant';
import { answerFromKnowledge, loadKnowledge, resolveVerifiedAudience } from './assistant';

test('loads structured local knowledge and maps an onboarding question', async () => {
  const knowledge = await loadKnowledge();
  const answer = answerFromKnowledge('What are the offer letter PDF requirements?', knowledge);

  assert.equal(knowledge.version, 1);
  assert.equal(answer.topicId, HelpTopicId.Onboarding);
  assert.match(answer.content, /unencrypted PDF under 5 MB/i);
});

test('YAML knowledge gives source-safe application guidance without inventing dashboard steps', async () => {
  const knowledge = await loadKnowledge();
  const answer = answerFromKnowledge('How do I apply for an internship?', knowledge);

  assert.equal(answer.topicId, HelpTopicId.InternshipDiscovery);
  assert.match(answer.content, /live listing/i);
  assert.match(answer.content, /application instructions/i);
  assert.doesNotMatch(answer.content, /Apply in One Click|My Internships|complete-guide-how-to-apply/i);
});

test('client audience selection is not treated as privileged identity', () => {
  const selectedAudience = AudienceContext.CaptainOrLead;
  assert.equal(
    resolveVerifiedAudience({ body: { audience: selectedAudience } }),
    AudienceContext.General
  );
  const answer = answerFromKnowledge(
    'How does attendance work?',
    { version: 1, topics: [{ id: 'attendance', topicId: HelpTopicId.Attendance, keywords: ['attendance'], content: 'Intern attendance is read-only; statuses are view-only.' }] },
    resolveVerifiedAudience({ body: { audience: selectedAudience } })
  );
  assert.match(answer.content, /intern.*read-only/i);
});

test('mutation requests retain the advisory-only boundary', async () => {
  const knowledge = await loadKnowledge();
  const answer = answerFromKnowledge('Mark my attendance as Present today', knowledge);

  assert.equal(answer.suggestEscalation, true);
  assert.match(answer.content, /cannot/i);
  assert.match(answer.guidance.boundaryNotice ?? '', /No record changes were made/i);
});
