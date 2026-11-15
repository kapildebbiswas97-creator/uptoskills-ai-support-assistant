import {
  ESCALATION_CATEGORY_GUIDANCE,
  OFFICIAL_SUPPORT,
  TOPIC_SUGGESTIONS_BY_AUDIENCE,
} from '../data/uptoskillsKnowledge.js';
import {
  AudienceContext,
  ConversationThread,
  EscalationCategory,
  HelpTopicId,
  StructuredGuidance,
  TopicSuggestion,
} from '../types/assistant.js';

export interface AssistantReplyResult {
  content: string;
  guidance: StructuredGuidance;
  followUps: string[];
  topicId: HelpTopicId;
  suggestEscalation: boolean;
}

export interface EscalationValidationResult {
  valid: boolean;
  errors: Partial<Record<'description', string>>;
}

export function getRelevantTopicsForAudience(
  audience: AudienceContext
): TopicSuggestion[] {
  return TOPIC_SUGGESTIONS_BY_AUDIENCE[audience] ?? TOPIC_SUGGESTIONS_BY_AUDIENCE[AudienceContext.General];
}

export function filterConversations(
  conversations: ConversationThread[],
  query: string,
  audienceFilter: AudienceContext | 'ALL'
): ConversationThread[] {
  const q = query.trim().toLowerCase();
  return conversations.filter((conv) => {
    if (audienceFilter !== 'ALL' && conv.audience !== audienceFilter) {
      return false;
    }
    if (!q) return true;
    const msgText = conv.messages.map((m) => m.content).join(' ').toLowerCase();
    return (
      conv.title.toLowerCase().includes(q) ||
      conv.audience.toLowerCase().includes(q) ||
      msgText.includes(q)
    );
  });
}

export function validateEscalationInput(description: string): EscalationValidationResult {
  const trimmed = description.trim();
  if (!trimmed || trimmed.length < 10) {
    return {
      valid: false,
      errors: {
        description:
          'Please enter a short issue description (at least 10 characters) so you have a clear summary to share with human support.',
      },
    };
  }
  return { valid: true, errors: {} };
}

export function buildEscalationSummary(params: {
  category: EscalationCategory;
  audience: AudienceContext;
  description: string;
}): string {
  const catInfo = ESCALATION_CATEGORY_GUIDANCE[params.category];
  return [
    `Subject: UpToSkills Support Request — ${params.category}`,
    `Context Preference: ${params.audience}`,
    `Recommended Contact: ${catInfo.primaryContact}`,
    `Official Email: ${OFFICIAL_SUPPORT.email} | Phone: ${OFFICIAL_SUPPORT.phone}`,
    '',
    'Issue Description:',
    params.description.trim(),
  ].join('\n');
}

function isOutOfScopeAdminMutation(lower: string): boolean {
  const mutationVerbs = [
    'mark me present',
    'mark my attendance',
    'change my attendance',
    'edit attendance',
    'update attendance for me',
    'approve my task',
    'reject task',
    'approve task',
    'change my rating',
    'edit rating',
    'modify rating',
    'update my stars',
    'generate my certificate',
    'issue certificate now',
    'check my record',
    'look up my record',
    'access my account',
    'bypass assessment',
    'skip ai interview',
    'revoke session for me',
    'reset password for me',
  ];
  return mutationVerbs.some((phrase) => lower.includes(phrase));
}

function isUnestablishedPolicyQuestion(lower: string): boolean {
  const unknownSignals = [
    'stipend',
    'salary',
    'how much pay',
    'exact deadline',
    'guarantee',
    'response time',
    'how many hours to approve',
    'github required',
    'must use github',
    'ppo',
  ];
  return unknownSignals.some((sig) => lower.includes(sig));
}

export function generateAssistantReply(
  query: string,
  audience: AudienceContext,
  explicitTopicId?: HelpTopicId
): AssistantReplyResult {
  const lower = query.toLowerCase();

  if (/^(hi|hello|hey|howdy|namaste|good morning|good afternoon|good evening)[\s!,.?]*$/i.test(query.trim())) {
    return {
      topicId: HelpTopicId.HumanSupport,
      suggestEscalation: false,
      content:
        'Hi! I’m your UpToSkills support assistant. I can help with internship applications, onboarding, and common InternOps questions. What would you like help with?',
      guidance: {
        title: 'I can help you with',
        summary: 'Choose a suggestion below or ask your question in your own words.',
        steps: [],
      },
      followUps: [
        'How do I apply for an internship?',
        'What should I prepare for onboarding?',
        'How do I contact support?',
      ],
    };
  }

  if (/^(thanks|thank you|thx|cheers)[\s!,.?]*$/i.test(query.trim())) {
    return {
      topicId: HelpTopicId.HumanSupport,
      suggestEscalation: false,
      content: 'You’re welcome! Ask me whenever you need help with UpToSkills.',
      guidance: {
        title: 'Need anything else?',
        summary: 'I can help with applications, onboarding, and common InternOps questions.',
        steps: [],
      },
      followUps: ['Browse internship guidance', 'Contact human support'],
    };
  }

  // 1. Strict advisory-only boundary check for administrative mutations or private record access
  if (isOutOfScopeAdminMutation(lower)) {
    return {
      topicId: HelpTopicId.HumanSupport,
      suggestEscalation: true,
      content:
        'I can only provide advisory guidance and navigation help—I cannot view private intern records, modify attendance, approve or reject tasks, change submitted ratings, generate official documents, or bypass assessments.',
      guidance: {
        title: 'Advisory-Only Product Boundary',
        summary:
          'This standalone assistant is not connected to InternOps administrative actions and cannot alter official internship records.',
        steps: [
          'For attendance updates or daily task review questions, contact your assigned Captain or Team Lead.',
          'Remember that submitted four-week ratings are permanent and immutable once finalized.',
          `For certificate, bonafide, or account issues, sign in directly to InternOps (${OFFICIAL_SUPPORT.internOpsUrl}) or contact UpToSkills human support.`,
        ],
        boundaryNotice:
          'No record changes were made. Use your InternOps account or contact an authorized human reviewer.',
        references: [{ label: 'Open InternOps', url: OFFICIAL_SUPPORT.internOpsUrl }],
      },
      followUps: [
        'Who is allowed to edit attendance records?',
        'How do I contact human support?',
        'How do I revise a rejected daily task?',
      ],
    };
  }

  // 2. Honest uncertainty check for unestablished policies (stipends, deadlines, GitHub mandates, turnaround times)
  if (isUnestablishedPolicyQuestion(lower)) {
    return {
      topicId: HelpTopicId.HumanSupport,
      suggestEscalation: true,
      content:
        'I do not have an established UpToSkills policy confirming fixed stipends, exact review turnaround times, deadlines, or mandatory third-party tooling such as GitHub for all tracks. Rather than guessing, I recommend checking the official listing or contacting human support.',
      guidance: {
        title: 'Official Policy Verification Needed',
        summary:
          'Details such as role-specific compensation, cohort timelines, or tool requirements are governed by the specific internship listing or your program lead.',
        steps: [
          `Check the specific role details on the public UpToSkills internship listings (${OFFICIAL_SUPPORT.internshipPortalUrl}).`,
          'Ask your assigned Captain or Team Lead for cohort-specific expectations.',
          `Contact UpToSkills Support at ${OFFICIAL_SUPPORT.email} or ${OFFICIAL_SUPPORT.phone} for official clarification.`,
        ],
        references: [
          { label: 'UpToSkills Internships', url: OFFICIAL_SUPPORT.internshipPortalUrl },
        ],
      },
      followUps: [
        'How do I find open internships?',
        'How do daily task submissions work?',
        'Contact human support',
      ],
    };
  }

  // 3. Offer Letter & Onboarding (explicit topic or keywords)
  if (
    explicitTopicId === HelpTopicId.Onboarding ||
    lower.includes('offer letter') ||
    lower.includes('onboarding') ||
    lower.includes('pdf') ||
    lower.includes('5 mb') ||
    lower.includes('5mb') ||
    lower.includes('registration')
  ) {
    return {
      topicId: HelpTopicId.Onboarding,
      suggestEscalation: false,
      content:
        'UpToSkills onboarding in InternOps includes registration with your required personal/program details and uploading your offer letter PDF. Make sure your offer letter is a clean, unencrypted PDF under 5 MB.',
      guidance: {
        title: 'Onboarding & Offer Letter PDF Requirements',
        summary:
          audience === AudienceContext.CaptainOrLead
            ? 'Captains and Team Leads can guide incoming interns to verify PDF formatting before escalating upload failures.'
            : 'Complete your registration details in InternOps and upload an unencrypted offer letter PDF up to 5 MB.',
        steps: [
          `Sign in to InternOps (${OFFICIAL_SUPPORT.internOpsUrl}) and open your onboarding registration form.`,
          'Verify all required registration fields accurately before proceeding to document upload.',
          'Export or save your offer letter as a clean, unencrypted PDF (remove any password protection).',
          'Confirm the file size is 5 MB or smaller, then upload it in the offer letter step.',
        ],
        notes: [
          'Maximum file size: 5 MB (clean, unencrypted PDF only).',
          'If an upload fails even with an unencrypted PDF under 5 MB, contact your Team Lead or info@uptoskills.com.',
        ],
        references: [{ label: 'InternOps Portal', url: OFFICIAL_SUPPORT.internOpsUrl }],
      },
      followUps: [
        'What should I do if my PDF is over 5 MB or encrypted?',
        'How does attendance tracking work after onboarding?',
        'How do I submit my first daily task?',
      ],
    };
  }

  // 4. Attendance
  if (
    explicitTopicId === HelpTopicId.Attendance ||
    lower.includes('attendance') ||
    lower.includes('present') ||
    lower.includes('absent')
  ) {
    const isLead = audience === AudienceContext.CaptainOrLead;
    return {
      topicId: HelpTopicId.Attendance,
      suggestEscalation: false,
      content: isLead
        ? 'InternOps tracks attendance using Present, Absent, and Leave statuses. Authorized Captains and Team Leads manage and update attendance records, while interns have view-only access.'
        : 'InternOps tracks attendance with three statuses: Present, Absent, and Leave. As an intern, your attendance view is read-only—only authorized Captains and Team Leads can manage or update attendance records.',
      guidance: {
        title: 'Attendance Statuses & Authorized Editing',
        summary: isLead
          ? 'Captains and Team Leads are responsible for accurate attendance updates inside InternOps.'
          : 'Interns can view Present, Absent, and Leave statuses in InternOps, while authorized Captains and Team Leads manage edits.',
        steps: isLead
          ? [
              `Open the attendance section inside InternOps (${OFFICIAL_SUPPORT.internOpsUrl}).`,
              'Review intern status entries: Present, Absent, or Leave.',
              'Apply authorized updates only for interns assigned under your supervision.',
              'Ensure approved Leave entries align with submitted leave requests.',
            ]
          : [
              `Open your InternOps dashboard (${OFFICIAL_SUPPORT.internOpsUrl}) to view your Present, Absent, and Leave records.`,
              'Remember that intern accounts have view-only access and cannot edit attendance directly.',
              'If you spot a discrepancy or have an approved leave not reflected, contact your assigned Captain or Team Lead.',
            ],
        notes: [
          'Statuses: Present, Absent, and Leave.',
          'This assistant cannot modify attendance records.',
        ],
        references: [{ label: 'InternOps Portal', url: OFFICIAL_SUPPORT.internOpsUrl }],
      },
      followUps: [
        'How do I submit a leave application?',
        'My Captain is unreachable for an attendance fix',
        'How do daily task submissions work?',
      ],
    };
  }

  // 5. Daily Tasks
  if (
    explicitTopicId === HelpTopicId.DailyTasks ||
    lower.includes('daily task') ||
    lower.includes('task submission') ||
    lower.includes('duplicate url') ||
    lower.includes('rejected')
  ) {
    const isLead = audience === AudienceContext.CaptainOrLead;
    return {
      topicId: HelpTopicId.DailyTasks,
      suggestEscalation: false,
      content: isLead
        ? 'Daily task submissions in InternOps include screenshot attachments or public project links, with duplicate URL restrictions enforced. Reviewers approve or reject submissions and provide feedback so interns can revise rejected work.'
        : 'You can submit daily tasks in InternOps using screenshot attachments or a public project link. Previously submitted URLs are blocked by duplicate URL restrictions, and if a reviewer rejects a task, you can revise and resubmit it using their feedback.',
      guidance: {
        title: 'Daily Task Submissions & Rejected Revisions',
        summary:
          'Submissions support screenshots or unique public project URLs and go through reviewer approval or rejection.',
        steps: isLead
          ? [
              'Inspect the intern’s screenshot attachment or open their public project link.',
              'Approve submissions that satisfy daily deliverables, or reject with clear, actionable remarks.',
              'Remind interns that duplicate URLs are restricted and rejected tasks should be revised using your feedback.',
            ]
          : [
              `Navigate to Daily Tasks inside InternOps (${OFFICIAL_SUPPORT.internOpsUrl}).`,
              'Attach a clear screenshot or paste a unique, publicly accessible project URL.',
              'Avoid reusing a URL from a previous submission, as duplicate URLs are restricted.',
              'If your submission is rejected, read the reviewer feedback, update your deliverable or link, and resubmit.',
            ],
        notes: [
          'Duplicate URLs are restricted across submissions.',
          'This assistant cannot approve, reject, or modify task submissions.',
        ],
        references: [{ label: 'InternOps Portal', url: OFFICIAL_SUPPORT.internOpsUrl }],
      },
      followUps: [
        'Why was my project link blocked as a duplicate URL?',
        'How do four-week ratings relate to my tasks?',
        'Who do I ask if reviewer feedback is unclear?',
      ],
    };
  }

  // 6. Ratings & Reviews
  if (
    explicitTopicId === HelpTopicId.Ratings ||
    lower.includes('rating') ||
    lower.includes('star') ||
    lower.includes('4-week') ||
    lower.includes('four-week') ||
    lower.includes('review cycle') ||
    lower.includes('remarks')
  ) {
    const isLead = audience === AudienceContext.CaptainOrLead;
    return {
      topicId: HelpTopicId.Ratings,
      suggestEscalation: false,
      content:
        'UpToSkills internship evaluations follow a four-week review cycle using a one-to-five-star rating scale alongside written reviewer remarks. Once submitted, ratings are permanent and immutable.',
      guidance: {
        title: 'Four-Week Rating Cycle & Immutability',
        summary: isLead
          ? 'Verify your 1-to-5-star rating and remarks carefully before submitting, because submitted ratings cannot be changed.'
          : 'Reviews run on a four-week cycle with a 1-to-5-star rating and remarks; submitted ratings are permanent.',
        steps: isLead
          ? [
              'Evaluate performance across the four-week review window.',
              'Select a rating on the 1-to-5-star scale and write constructive reviewer remarks.',
              'Double-check both the star score and remarks before clicking submit—ratings become permanent and immutable immediately upon submission.',
            ]
          : [
              `Open your performance or reviews section in InternOps (${OFFICIAL_SUPPORT.internOpsUrl}).`,
              'Check your four-week review cycle star rating (1 to 5 stars) and read the reviewer remarks.',
              'If you want guidance on improving for the next cycle, discuss the remarks with your assigned Captain or Team Lead.',
            ],
        notes: [
          'Submitted ratings are permanent and immutable.',
          'Neither interns nor this assistant can alter submitted ratings.',
        ],
        references: [{ label: 'InternOps Portal', url: OFFICIAL_SUPPORT.internOpsUrl }],
      },
      followUps: [
        'Can a Captain or support edit a submitted rating?',
        'How do I request my internship certificate?',
        'How do I contact my Team Lead or human support?',
      ],
    };
  }

  // 7. Requests & Certificates
  if (
    explicitTopicId === HelpTopicId.RequestsCertificates ||
    lower.includes('certificate') ||
    lower.includes('bonafide') ||
    lower.includes('leave') ||
    lower.includes('verification')
  ) {
    return {
      topicId: HelpTopicId.RequestsCertificates,
      suggestEscalation: false,
      content:
        'Leave applications, bonafide letter requests, and certificate generation requests are initiated inside InternOps. Issued certificates also support public certificate verification.',
      guidance: {
        title: 'Leave, Bonafide & Certificate Requests',
        summary:
          'Submit official leave, bonafide, and certificate requests through InternOps, and use public verification for issued certificates.',
        steps: [
          `Sign in to InternOps (${OFFICIAL_SUPPORT.internOpsUrl}) and open the Requests or Certificates section.`,
          'Choose the appropriate request type: Leave application, Bonafide letter request, or Certificate generation request.',
          'Provide accurate dates or required details and submit inside InternOps.',
          'For issued certificates, share the public certificate verification link or identifier so employers or institutions can verify authenticity.',
        ],
        notes: [
          'This assistant cannot generate certificates or approve leave/bonafide requests.',
          'For certificate verification problems, contact info@uptoskills.com.',
        ],
        references: [{ label: 'InternOps Portal', url: OFFICIAL_SUPPORT.internOpsUrl }],
      },
      followUps: [
        'How does public certificate verification work?',
        'How do leave requests affect attendance status?',
        'Contact human support for a certificate issue',
      ],
    };
  }

  // 8. Account Security & Multi-Device Sessions
  if (
    explicitTopicId === HelpTopicId.AccountSecurity ||
    lower.includes('security') ||
    lower.includes('device') ||
    lower.includes('session') ||
    lower.includes('revoke') ||
    lower.includes('logout') ||
    lower.includes('sign out')
  ) {
    return {
      topicId: HelpTopicId.AccountSecurity,
      suggestEscalation: false,
      content:
        'InternOps supports multi-device sessions and lets you review and revoke active sessions from your account security controls. Revoking a session signs that device out so it must re-authenticate.',
      guidance: {
        title: 'Multi-Device Sessions & Session Revocation',
        summary:
          'Manage active devices and revoke unrecognized sessions directly through your InternOps account controls.',
        steps: [
          `Sign in to InternOps (${OFFICIAL_SUPPORT.internOpsUrl}) and open your Account or Security settings.`,
          'Review the list of active multi-device sessions.',
          'Use the session revocation control on any unfamiliar or old device to terminate that session immediately.',
          'If you suspect unauthorized access and cannot sign in, contact human support right away.',
        ],
        notes: [
          'Never share passwords or private tokens in support messages.',
          'This standalone assistant does not access active session tokens or sign devices out for you.',
        ],
        references: [{ label: 'InternOps Portal', url: OFFICIAL_SUPPORT.internOpsUrl }],
      },
      followUps: [
        'What should I do if I am locked out of InternOps?',
        'How do I contact human support?',
      ],
    };
  }

  // 9. Internship Discovery & Application Guidance
  if (
    explicitTopicId === HelpTopicId.InternshipDiscovery ||
    lower.includes('internship') ||
    lower.includes('find') ||
    lower.includes('apply') ||
    lower.includes('application') ||
    lower.includes('remote') ||
    lower.includes('eligible') ||
    lower.includes('eligibility') ||
    lower.includes('ai interview') ||
    lower.includes('assessment')
  ) {
    return {
      topicId: HelpTopicId.InternshipDiscovery,
      suggestEscalation: false,
      content:
        'Current UpToSkills internship openings and role-specific details are published on the official internship page. Review the requirements and application instructions on the listing for the role you want.',
      guidance: {
        title: 'Internship Discovery & Application Guidance',
        summary:
          'Browse current listings and rely on each role’s own requirements and application instructions.',
        steps: [
          `Visit the official UpToSkills internship page (${OFFICIAL_SUPPORT.internshipPortalUrl}).`,
          'Open a listing and review the role description, stated requirements, and application instructions.',
          'If the listing describes an interview or assessment, follow the instructions shown on that listing.',
          'For questions about a specific application or a step the listing does not explain, contact UpToSkills support.',
        ],
        notes: [
          'Listings and application steps can vary by role. Verify current details on the official listing.',
          'This assistant cannot view, submit, or change an application.',
        ],
        references: [
          { label: 'UpToSkills Internships', url: OFFICIAL_SUPPORT.internshipPortalUrl },
        ],
      },
      followUps: [
        'What are the offer letter PDF requirements after selection?',
        'How does daily task tracking work once I join?',
        'Contact human support about an application',
      ],
    };
  }

  // 10. Human Support / Fallback
  if (lower.includes('human') || lower.includes('contact') || lower.includes('email') || lower.includes('phone') || lower.includes('support')) {
    return {
      topicId: HelpTopicId.HumanSupport,
      suggestEscalation: true,
      content:
        `You can reach official UpToSkills human support by email at ${OFFICIAL_SUPPORT.email} or by phone at ${OFFICIAL_SUPPORT.phone}. For day-to-day operational matters such as attendance or task feedback, contact your assigned Captain or Team Lead.`,
      guidance: {
        title: 'Reaching UpToSkills Human Support',
        summary:
          'Choose your assigned Captain / Team Lead for operational internship questions, or official UpToSkills support for account, certificate, or general inquiries.',
        steps: [
          'For attendance corrections or daily task review feedback, message your assigned Captain or Team Lead.',
          `For general, onboarding, certificate, or security support, email ${OFFICIAL_SUPPORT.email} or call ${OFFICIAL_SUPPORT.phone}.`,
          'Open the Human Support screen from the sidebar to prepare a clean issue summary before contacting support.',
        ],
      },
      followUps: [
        'Offer letter PDF requirements',
        'Attendance status rules',
        'Certificate and bonafide requests',
      ],
    };
  }

  // General fallback when query doesn't match a known UpToSkills topic
  return {
    topicId: HelpTopicId.HumanSupport,
    suggestEscalation: false,
    content:
      'I’m not sure about that one yet. I can help with UpToSkills applications, onboarding, and common InternOps questions, or connect you with human support.',
    guidance: {
      title: 'Try one of these topics',
      summary: 'Select a suggestion or ask about a specific internship or platform issue.',
      steps: [],
      references: [
        { label: 'UpToSkills Internships', url: OFFICIAL_SUPPORT.internshipPortalUrl },
        { label: 'InternOps Portal', url: OFFICIAL_SUPPORT.internOpsUrl },
      ],
    },
    followUps: [
      'Browse internships',
      'Application and onboarding help',
      'Contact human support',
    ],
  };
}
