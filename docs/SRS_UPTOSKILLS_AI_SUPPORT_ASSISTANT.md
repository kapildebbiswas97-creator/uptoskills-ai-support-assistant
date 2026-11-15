# Software Requirements Specification — UpToSkills AI Support Assistant

**Version 1.0 — Draft Pending Stakeholder Approval**  
**Date:** 13 November 2026  
**Audience:** Project Team, Intern Developers, Technical Lead, UpToSkills HR and authorised stakeholders.  
**Status:** Initial baseline; not approved.

## Document Control

| Field | Details |
|---|---|
| Project | UpToSkills AI Support Assistant |
| Version | 1.0 |
| Baseline date | 13 November 2026 |
| Status | Draft pending stakeholder approval |
| Requirements source | Section 2, “Official Requirements Baseline,” of the supplied Phase 6 prompt |
| Supporting reference | `UpToSkills_AI_Support_Assistant_SRS_and_Team_Plan.docx`; older source baseline, superseded where the Phase 6 baseline updates it |
| Architecture update | React + Node.js + MongoDB Atlas operational source of truth + PostgreSQL/pgvector retrieval, per project governance and Phase 6 baseline |

### Revision History

| Version | Date | Change |
|---|---|---|
| 1.0 | 13 November 2026 | Initial requirements baseline. |
| 1.0 repository transcription | 15 November 2026 | Transcribed the complete authoritative Phase 6 baseline, added document control and revision history, and recorded the current architecture. Requirement IDs and open decisions remain intact; no stakeholder approval is implied. |

> **Source distinction:** The Phase 6 prompt contains both work instructions and a separately labelled authoritative SRS baseline. This document transcribes the baseline, not the operational instructions. The attached DOCX is retained as an older reference; where its vector-store proposal or requirement wording differs, the Phase 6 baseline governs this Version 1.0 repository copy.

## 1. Project Description

The UpToSkills AI Support Assistant is a web-based conversational assistant for prospective interns, selected/incoming interns, current interns, and other authorised UpToSkills users. It answers questions using approved organisational information and uploaded knowledge documents.

The system helps users understand UpToSkills and its programmes, internship opportunities, application procedures and requirements, selection-related communications and next steps without making selection decisions, pre-onboarding instructions, and frequently asked organisational questions. Answers must use evidence from approved sources. When reliable information is unavailable, the assistant must not invent an answer; it should explain the limitation and offer an appropriate HR escalation route.

The system also supports HR escalation and meeting requests. A meeting is not confirmed until an authorised person or approved calendar integration actually confirms it.

## 2. Project Objectives

1. Provide a centralised support channel.
2. Reduce repetitive HR questions.
3. Explain application and internship procedures.
4. Provide pre-onboarding guidance.
5. Answer questions from authorised PDF and knowledge documents.
6. Give evidence-grounded answers with source references.
7. Escalate unanswered or sensitive questions to HR.
8. Allow users to submit meeting requests subject to approval.
9. Provide authorised staff with basic document and request management.
10. Maintain security, privacy, auditability, and reliability.

## 3. Intended Users and Roles

- **Prospective applicant:** Asks about UpToSkills, programmes, internships, and applications.
- **Selected/incoming intern:** Requests selection follow-up and pre-onboarding guidance.
- **Current intern:** Requests internship-related support and organisational information.
- **HR/authorised staff:** Reviews and handles escalations and meeting requests.
- **Administrator:** Manages approved knowledge documents, users/roles, and system settings.

Administrative or HR permissions must not be assumed for ordinary users.

## 4. Scope

### 4.1 In scope

- Responsive web-based chat and conversation history.
- Internship and organisation-related question answering.
- Approved PDF upload and ingestion.
- Document extraction, chunking, indexing, and retrieval.
- Retrieval-augmented generation (RAG), grounded answers, and source citations.
- Safe fallback when evidence is insufficient.
- HR escalation with user consent and minimal contact information.
- Meeting request submission and status tracking.
- Basic authorised administration.
- Authentication and role-based access control.
- Logging, security, testing, and deployment preparation.

### 4.2 Out of scope

- Hiring or candidate-selection decisions.
- Internship performance decisions.
- Legal, financial, or guaranteed-employment advice.
- Unrelated general-purpose question answering.
- Automatic changes to official organisational records.
- Calendar invitations without an approved integration and confirmation.
- Autonomous HR decisions or actions.

## 5. Assumptions and Constraints

- Frontend: React.
- Backend: Node.js.
- Operational application database: MongoDB Atlas.
- Retrieval database: PostgreSQL with pgvector.
- LLM and embedding providers must be configurable.
- Hosting and provider configuration must be verified separately.
- Calendar integration requires approval.
- Privacy, consent, and retention rules require stakeholder confirmation.
- Only authorised knowledge documents may be used.
- Scanned PDF and OCR requirements remain a stakeholder decision.
- MongoDB and PostgreSQL do not share distributed transactions; the application must account for partial failures explicitly.

## 6. Architecture Baseline

### 6.1 Request and workflow paths

The intended question flow is:

**React frontend → Node.js API → authentication and authorisation → knowledge retrieval and embedding search → evidence-grounded LLM response → citation validation → frontend.**

Document ingestion follows:

**Upload → validation → ingestion job → extraction → chunking → embeddings → PostgreSQL/pgvector.**

HR escalation follows:

**Consent → ticket creation → authorised HR review.**

Meeting requests follow:

**Request record → pending status → authorised confirmation or rejection.**

### 6.2 Data ownership

**MongoDB Atlas is the operational source of truth** for users, memberships, conversations, messages, document metadata/ownership/permissions/lifecycle, ingestion jobs, escalation tickets, meeting requests, and audit events when those workflows are implemented.

**PostgreSQL + pgvector is the retrieval system** for document chunks, embeddings, vector and lexical/hybrid retrieval, and retrieval metadata.

MongoDB remains authoritative for identity, ownership, permissions, and document lifecycle. Use stable document identifiers across MongoDB and PostgreSQL. Authorisation must occur before retrieval. Account for retries, idempotency, reconciliation, deletion propagation, and recovery. Do not assume distributed transactions between the databases.

### 6.3 Confirmed technical direction and unresolved decisions

The current technical baseline is React, Node.js, MongoDB Atlas for operational data, and PostgreSQL + pgvector for retrieval, with configurable LLM and embedding providers. The original attached DOCX left vector storage undecided; this baseline supersedes that proposal. D-04 remains listed for stakeholder confirmation of retrieval technology and operational ownership, with the current PostgreSQL + pgvector implementation explicitly recorded. No other business decision is resolved by the architecture statement.

## 7. Functional Requirements

Each requirement has a unique identifier and must be testable.

| ID | Requirement |
|---|---|
| FR-01 | The system shall provide a conversational chat interface. |
| FR-02 | The backend shall validate non-empty questions and enforce reasonable request-size limits. |
| FR-03 | The system shall search approved and indexed knowledge sources. |
| FR-04 | The assistant shall produce evidence-grounded answers and avoid unsupported factual claims. |
| FR-05 | Answers shall provide source document and, where available, section/page references. |
| FR-06 | The system shall answer questions about UpToSkills using approved organisational information. |
| FR-07 | The system shall explain application procedures using approved information. |
| FR-08 | The system shall provide pre-onboarding guidance using approved information. |
| FR-09 | Authorised administrators shall be able to upload approved PDF documents. |
| FR-10 | The system shall extract PDF text, chunk content, and index it for retrieval. |
| FR-11 | Administrators shall be able to inspect document status and deactivate or replace documents. |
| FR-12 | The assistant shall provide a safe fallback when evidence is insufficient. |
| FR-13 | Users shall be able to request HR escalation with appropriate consent. |
| FR-14 | The system shall store escalation records with minimal contact data, timestamps, and status. |
| FR-15 | Only authorised HR personnel shall review and update HR escalation records. |
| FR-16 | Users shall be able to submit meeting requests. |
| FR-17 | A meeting shall be shown as confirmed only after actual HR or approved calendar confirmation; otherwise its status shall remain pending or another truthful non-confirmed status. |
| FR-18 | The system shall maintain appropriate conversation context. |
| FR-19 | Users shall be able to submit feedback about assistant responses. |
| FR-20 | The system shall maintain operational event and error logs without unnecessarily storing sensitive conversation content. |

## 8. Non-Functional Requirements

Do not invent numeric performance or availability targets. Mark them TBD until approved.

| ID | Requirement |
|---|---|
| NFR-01 | **Performance:** Define measurable response-time and ingestion-time targets after stakeholder confirmation. |
| NFR-02 | **Availability and recovery:** Define uptime, backup, recovery-point, and recovery-time targets. |
| NFR-03 | **Usability:** Provide a clear, accessible, responsive interface. |
| NFR-04 | **Security:** Use HTTPS, secure secret handling, input validation, and appropriate security headers. |
| NFR-05 | **Access control:** Enforce authentication and role-based authorisation for protected operations. |
| NFR-06 | **Privacy:** Minimise personal-data collection and define consent, retention, and deletion rules. |
| NFR-07 | **Reliability:** Handle errors, retries, duplicate requests, and partial failures safely. |
| NFR-08 | **Maintainability:** Use modular, documented, testable code. |
| NFR-09 | **Scalability:** Support growth in users, documents, and conversations without compromising isolation. |
| NFR-10 | **AI safety and answer quality:** Resist unsupported answers and prompt injection; use citations and fallback behaviour. |
| NFR-11 | **Compatibility:** Support current major desktop and mobile browsers. |
| NFR-12 | **Observability:** Provide structured operational logs, health checks, and useful diagnostic information. |

## 9. Use Cases

### UC-01 — Ask a question

A user opens chat and submits a question. The system searches approved sources and returns an evidence-grounded answer with source references. If evidence is insufficient, it returns a safe fallback.

### UC-02 — Ask about an application

A prospective applicant asks about internship or application procedures. The system provides only approved information and does not make hiring decisions.

### UC-03 — Request onboarding guidance

A selected/incoming intern asks about pre-onboarding. The system retrieves approved instructions and offers HR escalation when needed.

### UC-04 — Update knowledge documents

An authorised administrator uploads a PDF. The system validates, extracts, chunks, indexes, and reports ingestion status. The administrator can inspect status and deactivate or replace documents.

### UC-05 — Escalate to HR

A user requests HR assistance, gives required consent, and submits minimal contact details. The system creates a persistent escalation record and returns a reference/status. Only authorised HR users may review and update it.

### UC-06 — Request a meeting

A user submits a meeting request. The system stores it and displays a pending state until an authorised HR user or approved calendar integration confirms or rejects it.

## 10. Data Entities

The logical data model includes:

- KnowledgeDocuments.
- DocumentChunks and retrieval index records.
- ConversationSessions.
- Messages.
- EscalationTickets.
- MeetingRequests.
- Users and Roles.
- Organisation memberships and permissions.
- IngestionJobs.
- AuditEvents.
- User feedback records.

Do not store plaintext passwords. Use the approved authentication system. Map each entity to its actual database and identify ownership, access rules, lifecycle, and retention requirements.

## 11. Proposed API Capabilities

The following are proposed capabilities, not mandatory route names. Map them to existing routes where appropriate:

- `POST /api/chat`
- `POST /api/admin/documents`
- `GET /api/admin/documents`
- `PATCH /api/admin/documents/:id`
- `POST /api/escalations`
- `GET /api/admin/escalations`
- `PATCH /api/admin/escalations/:id`
- `POST /api/meeting-requests`
- `GET /api/health`

Identify any required feedback, conversation-history, ingestion-status, and meeting-review APIs. Do not create duplicate routes where equivalent secure functionality already exists.

## 12. Security and Responsible AI

The implementation must consider:

- HTTPS and secure headers.
- Content Security Policy.
- Input validation and sanitisation.
- Upload type, size, and signature validation.
- Safe PDF parsing and resource limits.
- Malware scanning or documented fail-closed behaviour when required scanning is unavailable.
- Authentication and role-based authorisation.
- Tenant and document ownership isolation.
- Secure secret management.
- Rate limiting and abuse protection.
- Prompt-injection defence.
- Protection against unauthorised HR or private-data access.
- Source citations and safe fallback.
- Consent and data minimisation.
- Retention and deletion policies.
- Audit logging.
- Secure error handling.
- Protection against fabricated meeting confirmations.

Never expose private organisational information to unauthorised users.

## 13. Acceptance Criteria

The release should satisfy these conditions. AC-01–AC-12 are traceability labels assigned in source order.

1. **AC-01:** A supported question receives a source-grounded answer.
2. **AC-02:** The answer displays its supporting sources.
3. **AC-03:** Insufficient evidence produces a safe fallback and an escalation option.
4. **AC-04:** An authorised administrator can upload a valid PDF.
5. **AC-05:** The document is processed and becomes searchable.
6. **AC-06:** Invalid and oversized uploads are rejected safely.
7. **AC-07:** An escalation request creates a persistent ticket/reference.
8. **AC-08:** Only authorised HR users can access and update escalation records.
9. **AC-09:** A meeting request remains pending until genuine confirmation.
10. **AC-10:** The interface works on desktop and mobile.
11. **AC-11:** Automated unit, integration, security, and frontend tests cover critical flows.
12. **AC-12:** Failures and edge cases produce safe, understandable behaviour.

## 14. Testing Plan

- Unit tests for validation, permissions, ingestion, retrieval, status transitions, and error handling.
- API integration tests for chat, documents, escalation, meetings, and feedback.
- Frontend tests for chat, history, uploads, status displays, and user feedback.
- RAG evaluation for grounding, retrieval relevance, citations, and fallback.
- Security tests for authentication, tenant isolation, upload attacks, prompt injection, and unauthorised access.
- User acceptance testing with representative applicant, intern, HR, and administrator workflows.

Clearly distinguish mocked tests, unit tests, local service integration tests, staging tests, and production verification.

## 15. Team Workstreams

Preserve these workstream identifiers.

| ID | Workstream | Responsibilities |
|---|---|---|
| P0 | Project Lead/System Coordinator | Overall architecture, requirements, coordination, integration, review, and approval. |
| P1 | React Frontend | Chat interface, history, uploads, escalation, meeting requests, feedback, and administration screens. |
| P2 | Node Backend/API | API contracts, validation, authentication integration, business logic, and error handling. |
| P3 | PDF Ingestion/Knowledge Base | Upload validation, extraction, chunking, indexing, versioning, and ingestion status. |
| P4 | RAG/AI Engine | Embeddings, retrieval, grounded generation, citations, fallback, and evaluation. |
| P5 | MongoDB Data Model/Access Control | Operational data, identity, ownership, permissions, lifecycle, and persistence. |
| P6 | HR Escalation | Consent, ticket creation, status, HR-only review, and audit trail. |
| P7 | Meeting Request/Scheduling | Meeting request workflow, pending/confirmed/rejected states, and approved calendar integration if authorised. |
| P8 | QA/Security/Deployment | Testing, security, observability, documentation, staging, and deployment readiness. |

For each workstream, identify dependencies, deliverables, implementation status, and remaining work.

## 16. Recommended Implementation Order

1. Confirm requirements and open stakeholder decisions.
2. Define API contracts and data ownership.
3. Develop backend/database and frontend mock flows in parallel.
4. Complete document ingestion and RAG.
5. Complete chat interface and grounded answers.
6. Implement HR escalation.
7. Implement meeting requests.
8. Complete feedback and administrative workflows.
9. Complete security, testing, observability, and recovery.
10. Conduct staging integration and user acceptance testing.
11. Prepare production deployment only after explicit approval.

## 17. Open Stakeholder Decisions

Preserve these decisions as open. Do not invent answers.

| ID | Open decision |
|---|---|
| D-01 | Confirm the target user groups and whether anonymous access is permitted. |
| D-02 | Confirm the approved knowledge sources and who owns their accuracy and updates. |
| D-03 | Confirm the LLM/embedding provider, hosting, and data-processing requirements. |
| D-04 | Confirm the vector retrieval technology and operational ownership. Current implementation uses PostgreSQL + pgvector. |
| D-05 | Confirm authentication requirements, identity provider, and anonymous access policy. |
| D-06 | Confirm HR escalation destination, authorised reviewers, expected response SLA, and contact-data requirements. |
| D-07 | Confirm meeting request handling, calendar integration, and who can confirm or reject requests. |
| D-08 | Confirm whether scanned PDFs require OCR and which languages must be supported. |
| D-09 | Confirm conversation, document, escalation, and audit-data retention and deletion rules. |
| D-10 | Confirm hosting, performance, availability, backup, and recovery targets. |

No numerical performance or availability target, HR destination/SLA, calendar service, OCR scope, provider privacy policy, or retention period is assumed by this SRS.

## 18. Definition of Done

A requirement or feature is complete only when:

- It has an agreed requirement and API/data contract where applicable.
- It is implemented in the correct layer.
- Authentication and authorisation are enforced where needed.
- Validation and error handling are implemented.
- Relevant automated tests pass.
- Security and privacy implications are addressed.
- Documentation is updated.
- Changes are committed on an appropriate branch or submitted through a reviewed pull request.
- The project lead approves the work.

A passing build alone is not sufficient evidence.

## 19. Risks and Mitigations

- **Outdated knowledge documents:** Assign document ownership, review dates, and deactivation controls.
- **Unsupported AI answers:** Use evidence-grounded generation, citation validation, fallback, and evaluation.
- **PDF extraction failures:** Validate uploads, limit parser resources, report ingestion status, and decide OCR scope.
- **Missed HR escalations:** Agree ticket destination and owner; persist status and monitor failed notifications/retries.
- **Calendar unavailability:** Use a truthful pending meeting-request workflow; integrate calendars only after approval.
- **Integration conflicts:** Use stable contracts, clear data ownership, and regression tests.
- **Sensitive-data exposure:** Minimise collection, enforce RBAC and tenant isolation, restrict logs, and define retention/deletion.
- **Cross-database partial failure:** Use idempotent jobs, reconciliation, stable document IDs, deletion propagation, and recovery tests; do not assume distributed transactions.

## 20. Glossary

- **RAG:** Retrieval-Augmented Generation; retrieve relevant source content before generating an answer.
- **Embedding:** Numerical representation used for semantic retrieval.
- **Vector database:** Storage/retrieval system for vector representations; this architecture uses PostgreSQL + pgvector for retrieval.
- **HR escalation:** A user-approved request for assistance from authorised HR staff.
- **Meeting request:** A request for a meeting; it is not a confirmed calendar event.
- **RBAC:** Role-Based Access Control.
- **Tenant isolation:** Separation of one organisation's data and permissions from another's.
- **Source citation:** Reference to approved document content supporting an answer.
- **Ingestion job:** Durable operational record of document processing and recovery state.

### Release priority

The first release prioritises reliable Q&A, approved document ingestion, and HR escalation. Meeting automation should follow the basic request-and-review workflow and only integrate with a calendar after stakeholder approval.
