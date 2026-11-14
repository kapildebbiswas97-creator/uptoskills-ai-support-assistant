import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEscalationSummary,
  filterConversations,
  generateAssistantReply,
  getRelevantTopicsForAudience,
  validateEscalationInput,
} from './assistantEngine';
import {
  AudienceContext,
  ConversationThread,
  EscalationCategory,
  HelpTopicId,
  MessageRole,
} from '../types/assistant';

test('onboarding guidance enforces unencrypted PDF and 5 MB limit', () => {
  const res = generateAssistantReply(
    'How do I upload my offer letter PDF?',
    AudienceContext.Applicant
  );
  assert.equal(res.topicId, HelpTopicId.Onboarding);
  assert.match(res.content, /unencrypted PDF/i);
  assert.match(res.content, /5 MB/i);
});

test('greeting receives a warm welcome and useful next-step suggestions', () => {
  const reply = generateAssistantReply('hi', AudienceContext.General);

  assert.match(reply.content, /^Hi!/);
  assert.match(reply.content, /What would you like help with\?/);
  assert.equal(reply.suggestEscalation, false);
  assert.equal(reply.guidance.steps.length, 0);
  assert.ok(reply.followUps?.some((prompt) => /apply for an internship/i.test(prompt)));
});

test('thanks receives a short conversational response', () => {
  const reply = generateAssistantReply('thank you', AudienceContext.General);
  assert.match(reply.content, /You’re welcome/i);
  assert.equal(reply.suggestEscalation, false);
});

test('internship guidance avoids unverified one-click, dashboard, and assessment claims', () => {
  const reply = generateAssistantReply('How do I apply for an internship?', AudienceContext.Applicant);
  const guidance = [reply.content, reply.guidance.summary, ...reply.guidance.steps, ...(reply.guidance.notes ?? [])].join(' ');
  assert.match(guidance, /official UpToSkills internship page/i);
  assert.match(guidance, /role.?s own requirements|role description/i);
  assert.doesNotMatch(guidance, /Apply in One Click|My Internships|assessment indicator/i);
});

test('attendance guidance differentiates intern view-only vs Captain/Team Lead management', () => {
  const internRes = generateAssistantReply(
    'How does attendance work?',
    AudienceContext.Intern
  );
  assert.equal(internRes.topicId, HelpTopicId.Attendance);
  assert.match(internRes.content, /view-only|read-only/i);
  assert.match(internRes.content, /Present, Absent, and Leave/i);

  const leadRes = generateAssistantReply(
    'How does attendance work?',
    AudienceContext.CaptainOrLead
  );
  assert.equal(leadRes.topicId, HelpTopicId.Attendance);
  assert.match(leadRes.content, /Captains and Team Leads manage/i);
});

test('daily task guidance covers screenshots, public links, duplicate URL rules, and rejected revisions', () => {
  const res = generateAssistantReply(
    'How do daily task submissions work?',
    AudienceContext.Intern
  );
  assert.equal(res.topicId, HelpTopicId.DailyTasks);
  assert.match(res.content, /duplicate URL/i);
  assert.match(res.content, /revise/i);
});

test('ratings guidance enforces 4-week cycle, 1-to-5-star scale, and immutability', () => {
  const res = generateAssistantReply(
    'Can I change my 4-week star rating?',
    AudienceContext.Intern
  );
  assert.equal(res.topicId, HelpTopicId.Ratings);
  assert.match(res.content, /four-week/i);
  assert.match(res.content, /permanent and immutable/i);
});

test('strict advisory boundary refuses administrative record mutations', () => {
  const res = generateAssistantReply(
    'Mark my attendance as Present today',
    AudienceContext.Intern
  );
  assert.equal(res.suggestEscalation, true);
  assert.match(res.content, /cannot/i);
  assert.ok(res.guidance.boundaryNotice);
});

test('unknown or unestablished policy questions acknowledge uncertainty rather than guessing', () => {
  const res = generateAssistantReply(
    'What is the exact guaranteed stipend amount?',
    AudienceContext.Applicant
  );
  assert.equal(res.suggestEscalation, true);
  assert.match(res.content, /do not have an established UpToSkills policy/i);
});

test('getRelevantTopicsForAudience returns audience-specific topics', () => {
  const applicantTopics = getRelevantTopicsForAudience(AudienceContext.Applicant);
  const internTopics = getRelevantTopicsForAudience(AudienceContext.Intern);
  assert.equal(applicantTopics.length, 4);
  assert.equal(internTopics.length, 4);
  assert.notEqual(applicantTopics[0].label, internTopics[0].label);
});

test('escalation validation and summary builder work cleanly without claiming backend submission', () => {
  const invalid = validateEscalationInput('short');
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.description);

  const valid = validateEscalationInput('My offer letter PDF failed validation even though it is under 5 MB.');
  assert.equal(valid.valid, true);

  const summary = buildEscalationSummary({
    category: EscalationCategory.OnboardingOfferLetter,
    audience: AudienceContext.Applicant,
    description: 'My offer letter PDF failed validation even though it is under 5 MB.',
  });
  assert.match(summary, /info@uptoskills\.com/);
  assert.match(summary, /\+91-9319772294/);
});

test('filterConversations filters by query and audience context', () => {
  const threads: ConversationThread[] = [
    {
      id: 'c1',
      title: 'Offer letter PDF help',
      audience: AudienceContext.Applicant,
      updatedAt: 'Today',
      messages: [{ id: 'm1', role: MessageRole.User, content: '5 MB PDF', timestamp: '10:00' }],
    },
    {
      id: 'c2',
      title: 'Attendance status question',
      audience: AudienceContext.Intern,
      updatedAt: 'Today',
      messages: [{ id: 'm2', role: MessageRole.User, content: 'Leave status', timestamp: '11:00' }],
    },
  ];
  assert.equal(filterConversations(threads, '', AudienceContext.Intern).length, 1);
  assert.equal(filterConversations(threads, '5 MB', 'ALL').length, 1);
});
