# UpToSkills AI Support Assistant

This project keeps the approved Stitch React interface and adds a local Express API. It supports natural multi-turn chat and streaming through seven hosted provider APIs. Provider keys stay on the server; model weights are never downloaded to a visitor's device.

## AI provider and model switching

1. Copy `.env.example` to `.env`.
2. Add one or more keys from the provider dashboards to their matching variables: `OPENROUTER_API_KEY`, `GEMINI_API_KEY` (or `GOOGLE_API_KEY`), `GROQ_API_KEY`, `CLOUDFLARE_API_TOKEN` plus `CLOUDFLARE_ACCOUNT_ID`, `CEREBRAS_API_KEY`, `NVIDIA_API_KEY`, `MISTRAL_API_KEY`, or `REQUESTY_API_KEY`.
3. Choose a provider and model in the picker at the top of the welcome or chat screen. The picker loads each configured provider's model catalog and remembers your choice in this browser. `AI_PROVIDER` and `AI_MODEL` choose the default. The OpenRouter list is filtered to zero-price text chat models and defaults to `openrouter/free`.
4. Restart `npm run server` after changing `.env`.

The adapters support hosted providers: OpenRouter, Google Gemini, Groq, Cloudflare Workers AI, Cerebras, NVIDIA NIM, Mistral AI, and Requesty. API keys are never sent to the browser. Only OpenRouter's catalog is strictly filtered to zero-price models; the other provider APIs do not all expose a reliable free-price flag, so their current account catalog is shown and provider pricing/quotas may apply. Check each provider console before choosing a model or sending personal documents. Free limits, model availability, privacy terms, and model licenses vary and can change. A $0 hosted price does not establish an OSI-approved open-source license. `AI_WEB_SEARCH=true` enables OpenRouter's web-search tool for research-like prompts; it may cost extra.

Cloudflare Workers AI requires both an account ID and API token. Its catalog is loaded from the account's text-generation model search. Requests use the account-scoped OpenAI-compatible chat-completions endpoint.

The configuration also accepts the legacy `AI_API_KEY` and `AI_BASE_URL` variables for OpenRouter/custom OpenAI-compatible endpoints. Do not use anonymous no-key gateways for resumes or other personal information; this app does not vouch for their operators, retention, or security.

The assistant can discuss general topics, help with code, and draft research or automation plans. It does not execute code, send HR messages, schedule jobs, or connect to external accounts. It does not currently perform real browser research unless the selected provider/model's online-search variant is available and enabled.

## PDF knowledge base

Put approved, text-readable `.pdf` files in the project's `docs/` directory. The index also accepts curated `.md` and `.txt` references. At server startup, the API extracts their text, splits it into overlapping chunks, and indexes it in memory with BM25. The index refreshes after supported files are added, changed, or removed while the server is running. Each chat request retrieves up to four relevant passages. Uploaded PDF attachments up to 3 MiB are extracted for that request and are not saved to `docs/`.

Policy and workflow answers are grounded in retrieved PDF passages and the existing structured `knowledge.yaml`. When the source material does not support an answer, the model is instructed to say that and append the internal `[SHOW_HR_BUTTON]` marker; the server removes the marker from visible text and returns the existing escalation metadata. Requests for human support also trigger escalation. Never put confidential or personal data in a PDF unless your chosen AI provider is approved to process it. Scanned/image-only PDFs need OCR before this text index can use them.

No original policy PDFs were included with the supplied prototype archive. The `docs/` folder now includes compact, source-linked references from the official UptoSkills GitHub BrandKit and public internship page; these provide brand and general public internship context, not internal policy. The `docs/README.md` file explains how to add approved policy PDFs.

## Run locally on Windows PowerShell

Run these commands from the project folder (`work/source-archive`):

```powershell
npm install
Copy-Item .env.example .env
# Edit .env and set at least one provider API key for model-backed chat and PDF analysis.
npm run server
```

In a second PowerShell window, from the same project folder:

```powershell
npm run dev
```

Open `http://127.0.0.1:3000`. Vite forwards `/api` requests to Express on port `3001`. The UI and local knowledge fallback work without PostgreSQL or Redis. Without a provider key, general coding/research requests and PDF analysis return a clear setup message while supported local help topics still work.

## Optional PostgreSQL and Redis

`docker compose --profile infrastructure up -d` starts optional local PostgreSQL 16 with pgvector and Redis. The runtime database connection uses the read-only `uts_assistant_reader` account. PostgreSQL search is optional; the local YAML knowledge and PDF BM25 index do not depend on it. The existing database seed utility still uses the legacy Gemini embedding configuration and is not part of this provider-neutral chat integration.

## Verification

```powershell
npm test
npm run lint
npm run build
```
