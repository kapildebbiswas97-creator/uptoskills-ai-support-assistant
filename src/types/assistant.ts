export enum AudienceContext {
  Applicant = 'Applicant',
  Intern = 'Intern',
  CaptainOrLead = 'Captain / Team Lead',
  General = 'General',
}

export enum AppView {
  Welcome = 'welcome',
  Chat = 'chat',
  History = 'history',
  Escalation = 'escalation',
}

export enum MessageRole {
  User = 'user',
  Assistant = 'assistant',
}

export enum HelpTopicId {
  InternshipDiscovery = 'internship-discovery',
  Onboarding = 'onboarding',
  Attendance = 'attendance',
  DailyTasks = 'daily-tasks',
  Ratings = 'ratings',
  RequestsCertificates = 'requests-certificates',
  AccountSecurity = 'account-security',
  HumanSupport = 'human-support',
}

export enum EscalationCategory {
  ApplicationAssessment = 'Internship Application & Assessment',
  OnboardingOfferLetter = 'Onboarding & Offer Letter PDF',
  AttendanceRecord = 'Attendance Record & Status',
  DailyTaskReview = 'Daily Task Submission & Review',
  RatingsFeedback = 'Four-Week Ratings & Remarks',
  LeaveBonafideCertificate = 'Leave, Bonafide & Certificate Requests',
  AccountSecurity = 'Account Security & Multi-Device Sessions',
  OtherInquiry = 'Other Platform Guidance',
}

export interface ReferenceLink {
  label: string;
  url: string;
}

export interface StructuredGuidance {
  title: string;
  summary: string;
  steps: string[];
  notes?: string[];
  references?: ReferenceLink[];
  boundaryNotice?: string;
}

export interface AssistantMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: string;
  guidance?: StructuredGuidance;
  followUps?: string[];
  topicId?: HelpTopicId;
  suggestEscalation?: boolean;
}

export interface PdfAttachmentPayload {
  name: string;
  mimeType: 'application/pdf';
  data: string;
}

export interface ChatHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AIModelOption {
  id: string;
  name: string;
  description?: string;
  contextLength?: number | null;
}

export interface ConversationThread {
  id: string;
  title: string;
  audience: AudienceContext;
  topicId?: HelpTopicId;
  updatedAt: string;
  messages: AssistantMessage[];
}

export interface QuickActionItem {
  id: string;
  label: string;
  description: string;
  prompt?: string;
  topicId: HelpTopicId;
  opensEscalation?: boolean;
}

export interface TopicSuggestion {
  topicId: HelpTopicId;
  label: string;
  prompt: string;
}
