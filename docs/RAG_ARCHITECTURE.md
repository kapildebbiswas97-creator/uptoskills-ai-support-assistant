# RAG Architecture

## Implemented path

Curated YAML and local Markdown/PDF BM25 knowledge remain available. Authenticated document upload accepts PDF, DOCX, TXT, Markdown, and HTML. The API validates and hashes files, stores document content/metadata and ingestion jobs in MongoDB, extracts text with page/section metadata where available, deduplicates and chunks passages, batches Gemini embeddings, and writes chunks to PostgreSQL/pgvector transactionally. MongoDB remains the lifecycle source of truth and marks a document ready only after vector insertion succeeds.

At query time, the API embeds the question and combines PostgreSQL cosine and full-text rankings with reciprocal-rank fusion. It filters by embedding model/version and tenant/document scope, rechecks MongoDB authorization after search, deduplicates and lexical-reranks results, and provides source-labelled excerpts to the model. Model-written source labels are removed; a citation footer is generated from retrieved source records. Unsupported-answer patterns suppress that footer.

## Partial / not verified

- Retrieval and ingestion have no live database or embedding-provider integration test. Dimensions are fixed to 768 for the checked-in schema.
- The reranker is a lightweight lexical overlap score, not a trained/semantic cross-encoder. Chunk boundaries are paragraph/sentence-oriented but not token-aware; section/page metadata is best-effort and PDF extraction may lose layout.
- Citation validation establishes that labels came from retrieved records, not that each claim is entailed by the cited passage. Unsupported-answer detection is a rule-based pattern check rather than calibrated confidence/abstention.
- Streaming buffers the generated response before validation, then emits a reviewed delta and completion event. This reduces progressive streaming latency. Pattern-based screening blocks selected secret and internal-prompt disclosures, but it is not comprehensive DLP and cannot guarantee detection of every sensitive answer.
- Retrieved documents are untrusted prompt data. Uploads require a configured scanner and fail closed otherwise; PDF/DOCX/HTML parsing is isolated in a worker with bounded time/heap, but worker threads are not OS sandboxes and there is no scanner configured in this checkout. Prompt-injection detection is not comprehensive. Never grant the model privileged tools based on document text.

MongoDB Vector Search is not used. PostgreSQL/pgvector remains the vector retrieval engine.
