import {
  AudienceContext,
  EscalationCategory,
  HelpTopicId,
  QuickActionItem,
  TopicSuggestion,
} from '../types/assistant.js';

export const OFFICIAL_SUPPORT = {
  brandName: 'UpToSkills AI Support Assistant',
  logoUrl: 'https://uptoskills.com/uslogo.webp',
  email: 'info@uptoskills.com',
  phone: '+91-9319772294',
  internshipPortalUrl: 'https://uptoskills.com/intern-with-uptoskills',
  internOpsUrl: 'https://internops.uptoskills.com/',
} as const;

export const AUDIENCE_CONTEXT_DESCRIPTIONS: Record<AudienceContext, string> = {
  [AudienceContext.Applicant]:
    'Focuses on internship discovery, applications, assessments, and onboarding steps.',
  [AudienceContext.Intern]:
    'Focuses on InternOps daily tasks, attendance visibility, 4-week ratings, leave, and certificates.',
  [AudienceContext.CaptainOrLead]:
    'Focuses on guiding interns, authorized attendance management, task reviews, and review cycles.',
  [AudienceContext.General]:
    'Balanced platform guidance across discovery, onboarding, InternOps workflows, and support.',
};

export const WELCOME_QUICK_ACTIONS: QuickActionItem[] = [
  {
    id: 'qa-find-internships',
    label: 'Find internships',
    description: 'Browse public remote internship openings and role eligibility.',
    prompt: 'How do I find and filter open UpToSkills internships?',
    topicId: HelpTopicId.InternshipDiscovery,
  },
  {
    id: 'qa-application-guidance',
    label: 'Application guidance',
    description: 'Understand the application steps, AI interview, and assessments.',
    prompt: 'What should I expect during the UpToSkills internship application and AI assessment?',
    topicId: HelpTopicId.InternshipDiscovery,
  },
  {
    id: 'qa-offer-onboarding',
    label: 'Offer letter and onboarding',
    description: 'PDF format rules (unencrypted, max 5 MB) and registration steps.',
    prompt: 'How do I complete onboarding and upload my offer letter PDF?',
    topicId: HelpTopicId.Onboarding,
  },
  {
    id: 'qa-attendance-help',
    label: 'Attendance help',
    description: 'Present, Absent, and Leave statuses plus who can edit records.',
    prompt: 'How does attendance tracking work and who can update attendance records?',
    topicId: HelpTopicId.Attendance,
  },
  {
    id: 'qa-daily-tasks',
    label: 'Daily task submission',
    description: 'Screenshots, public links, duplicate URL rules, and rejected revisions.',
    prompt: 'How do daily task submissions work and how do I revise a rejected task?',
    topicId: HelpTopicId.DailyTasks,
  },
  {
    id: 'qa-ratings-reviews',
    label: 'Ratings and reviews',
    description: 'Four-week cycle, 1-to-5 star scale, remarks, and immutability.',
    prompt: 'How do four-week internship ratings and reviewer remarks work?',
    topicId: HelpTopicId.Ratings,
  },
  {
    id: 'qa-certificates',
    label: 'Certificates',
    description: 'Certificate requests, bonafide letters, leave, and public verification.',
    prompt: 'How do I request a certificate or bonafide letter and verify a certificate?',
    topicId: HelpTopicId.RequestsCertificates,
  },
  {
    id: 'qa-human-support',
    label: 'Contact human support',
    description: 'Official email, phone, and Captain / Team Lead escalation instructions.',
    topicId: HelpTopicId.HumanSupport,
    opensEscalation: true,
  },
];

export const TOPIC_SUGGESTIONS_BY_AUDIENCE: Record<AudienceContext, TopicSuggestion[]> = {
  [AudienceContext.Applicant]: [
    {
      topicId: HelpTopicId.InternshipDiscovery,
      label: 'Public internship listings',
      prompt: 'Where can I browse current UpToSkills internship openings?',
    },
    {
      topicId: HelpTopicId.InternshipDiscovery,
      label: 'AI interview & assessments',
      prompt: 'How do AI interviews and assessments work for internship applicants?',
    },
    {
      topicId: HelpTopicId.Onboarding,
      label: 'Offer letter PDF requirements',
      prompt: 'What are the exact requirements for uploading an offer letter PDF?',
    },
    {
      topicId: HelpTopicId.AccountSecurity,
      label: 'Account security & sessions',
      prompt: 'How do multi-device sessions and session revocation work?',
    },
  ],
  [AudienceContext.Intern]: [
    {
      topicId: HelpTopicId.Attendance,
      label: 'Attendance statuses & access',
      prompt: 'Why is my attendance view-only and what do Present, Absent, and Leave mean?',
    },
    {
      topicId: HelpTopicId.DailyTasks,
      label: 'Daily task & duplicate URL rules',
      prompt: 'What attachments or links are allowed for daily tasks and why are duplicate URLs blocked?',
    },
    {
      topicId: HelpTopicId.Ratings,
      label: '4-week rating rules',
      prompt: 'How does the four-week rating cycle work and can submitted ratings be changed?',
    },
    {
      topicId: HelpTopicId.RequestsCertificates,
      label: 'Leave, bonafide & certificates',
      prompt: 'How do I submit a leave application, bonafide request, or certificate request?',
    },
  ],
  [AudienceContext.CaptainOrLead]: [
    {
      topicId: HelpTopicId.Attendance,
      label: 'Managing intern attendance',
      prompt: 'How does authorized attendance management work for Captains and Team Leads?',
    },
    {
      topicId: HelpTopicId.DailyTasks,
      label: 'Reviewing daily tasks',
      prompt: 'How should reviewers handle task approval, rejection feedback, and resubmissions?',
    },
    {
      topicId: HelpTopicId.Ratings,
      label: 'Submitting 4-week ratings',
      prompt: 'What should Captains and Team Leads know before submitting permanent 4-week ratings?',
    },
    {
      topicId: HelpTopicId.AccountSecurity,
      label: 'Session revocation guidance',
      prompt: 'How can users review active devices and revoke unrecognized sessions?',
    },
  ],
  [AudienceContext.General]: [
    {
      topicId: HelpTopicId.InternshipDiscovery,
      label: 'Internship discovery',
      prompt: 'How do I find and apply for remote internships at UpToSkills?',
    },
    {
      topicId: HelpTopicId.Onboarding,
      label: 'Onboarding & 5 MB PDF rule',
      prompt: 'What information and offer letter PDF rules apply during onboarding?',
    },
    {
      topicId: HelpTopicId.RequestsCertificates,
      label: 'Certificate verification',
      prompt: 'How does public certificate verification work on UpToSkills?',
    },
    {
      topicId: HelpTopicId.AccountSecurity,
      label: 'Multi-device security',
      prompt: 'How do I manage multi-device sessions and revoke access?',
    },
  ],
};

export const ESCALATION_CATEGORY_GUIDANCE: Record<
  EscalationCategory,
  {
    primaryContact: string;
    guidance: string;
    checklist: string[];
  }
> = {
  [EscalationCategory.ApplicationAssessment]: {
    primaryContact: 'UpToSkills Support Team (info@uptoskills.com)',
    guidance:
      'For questions about public listings, eligibility, or technical issues during an AI interview or assessment, contact official UpToSkills support.',
    checklist: [
      'Include the internship role title you applied for.',
      'Mention the email address used on your application.',
      'Describe any error message shown during the assessment.',
    ],
  },
  [EscalationCategory.OnboardingOfferLetter]: {
    primaryContact: 'UpToSkills Support Team or Assigned Team Lead',
    guidance:
      'Offer letter uploads require a clean, unencrypted PDF that is 5 MB or smaller. Password-protected or oversized PDFs will not validate.',
    checklist: [
      'Confirm your file is a standard, unencrypted .pdf under 5 MB.',
      'Include your registered onboarding email (do not send passwords or tokens).',
      'Describe which registration field or upload step failed.',
    ],
  },
  [EscalationCategory.AttendanceRecord]: {
    primaryContact: 'Your Assigned Captain or Team Lead',
    guidance:
      'Interns have view-only access to Present, Absent, and Leave statuses. Only authorized Captains and Team Leads can edit attendance records in InternOps.',
    checklist: [
      'Contact your assigned Captain or Team Lead directly for date corrections.',
      'Specify the exact date and whether you submitted an approved Leave request.',
      'Escalate to info@uptoskills.com only if your Captain or Team Lead is unreachable.',
    ],
  },
  [EscalationCategory.DailyTaskReview]: {
    primaryContact: 'Your Assigned Captain or Team Lead',
    guidance:
      'Daily task submissions accept screenshot attachments or public project links, disallow duplicate URLs, and may be revised after reviewer rejection feedback.',
    checklist: [
      'Verify your project link is publicly accessible and not a duplicate of a prior submission.',
      'Review any rejection remarks from your reviewer before resubmitting.',
      'Reach out to your Captain or Team Lead for clarification on reviewer feedback.',
    ],
  },
  [EscalationCategory.RatingsFeedback]: {
    primaryContact: 'Your Assigned Captain or Team Lead',
    guidance:
      'Ratings follow a four-week review cycle on a 1-to-5-star scale with reviewer remarks. Submitted ratings are permanent and immutable.',
    checklist: [
      'Remember that submitted ratings cannot be edited once finalized.',
      'Ask your assigned Captain or Team Lead if you need clarification on written remarks.',
      'Contact info@uptoskills.com for platform-level review cycle concerns.',
    ],
  },
  [EscalationCategory.LeaveBonafideCertificate]: {
    primaryContact: 'UpToSkills Support Team & Assigned Team Lead',
    guidance:
      'Leave applications, bonafide letter requests, and certificate generation requests are handled via InternOps, with public verification available for issued certificates.',
    checklist: [
      'Specify whether your request is for Leave, a Bonafide letter, or Certificate generation/verification.',
      'Include your registered InternOps email and cohort/internship track if known.',
      'For certificate verification issues, include the verification reference or URL.',
    ],
  },
  [EscalationCategory.AccountSecurity]: {
    primaryContact: 'UpToSkills Support Team (info@uptoskills.com)',
    guidance:
      'You can view active multi-device sessions and revoke unrecognized sessions directly inside your InternOps account security controls.',
    checklist: [
      'Revoke any unrecognized device session from your InternOps account settings first.',
      'Never share passwords, OTPs, or session tokens in emails or chat.',
      'Contact info@uptoskills.com or +91-9319772294 if you remain locked out.',
    ],
  },
  [EscalationCategory.OtherInquiry]: {
    primaryContact: 'UpToSkills Support Team (info@uptoskills.com)',
    guidance:
      'If your question falls outside documented platform workflows or requires account-specific verification, reach out to official human support.',
    checklist: [
      'Include your role (Applicant, Intern, Captain, or Team Lead).',
      'Summarize what you tried in InternOps or on uptoskills.com.',
      'Provide a clear description without including private credentials.',
    ],
  },
};
