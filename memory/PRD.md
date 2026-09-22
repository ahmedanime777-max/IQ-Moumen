# PRD — IQ / Aptitude Trainer MCP Server

## Problem statement
Build a production-ready, GENERIC MCP server for ChatGPT that turns user-uploaded IQ/aptitude/
reasoning PDFs into an interactive training knowledge base (not just PDF search). Must support
adding new PDFs without code changes, semantic vector search, page-accurate attribution,
image-based questions, quizzes, answer checking (source-first), duplicate detection, Docker,
Bearer-token-protected `POST /mcp`, and a web dashboard.

## Tech / architecture (implemented)
- **Node.js 20 + TypeScript** (run via `tsx`), Express.
- **MCP** `@modelcontextprotocol/sdk` Streamable HTTP (stateless) at `POST /mcp` (+ `/api/mcp` alias), Bearer auth.
- **Qdrant** vector DB (native binary here on :6333; `qdrant/qdrant` in compose). Questions stored as vectors + full payload; JSON registry for documents/quizzes.
- **Embeddings**: pluggable — local `@xenova/transformers` MiniLM (384-d, offline default) or OpenAI.
- **Extraction**: poppler (`pdftotext`/`pdftoppm`/`pdfimages`), page numbers preserved, cross-page question handling, answer-key/choices/explanation parsing, category + difficulty heuristics, figure detection + page-image rendering.
- **LLM (optional)**: category/difficulty/reasoning fallback only when source lacks them. Providers: `none`/`openai`/`bridge`. In Emergent preview: `bridge` -> Python `backend/server.py` using Emergent Universal Key (gpt-4o).
- **Dashboard** (`public/`): upload, list, re-index, delete, semantic search, question inspector.

## Environment specifics (Emergent preview)
- Node server runs on **port 3000** (via the frontend supervisor hook: `frontend/package.json` start -> `tsx src/server/index.ts`), so the preview URL exposes `/mcp`, `/health`, `/`, `/rest/*`.
- Qdrant runs via `/etc/supervisor/conf.d/qdrant.conf` (native binary in `/app/vendor`, storage in `/app/data/qdrant`).
- Python LLM bridge on :8001 (`/api/llm/complete`).
- Public URL: https://logic-engine-23.preview.emergentagent.com  | MCP: `/mcp`.

## MCP tools
list_sources, search_sources, get_question, get_random_question, generate_quiz, check_answer,
get_explanation, get_similar_questions, get_source_info (+ ChatGPT-compat `search`/`fetch`).

## Status (2026-09-21)
- All core features implemented and verified. 29 automated tests pass (unit + live e2e).
- Sample generic PDF generated and indexed (12 questions, figure page rendered).
- Semantic search, image content blocks over MCP, source-first answer checking, and LLM
  explanation fallback all verified end-to-end. Answer-key pages excluded from search.

## v2 enhancements (2026-09-22)
- **Arabic-first presentation**: every question/choice/explanation returned by MCP tools is presented in Arabic with WESTERN digits (0-9). English/other sources are auto-translated to Arabic (LLM bridge) and cached in Qdrant; Arabic-Indic digits are normalized to Western at ingestion and output. Arabic-first retrieval (prefers `language=ar`, falls back to any).
- **Source variants + cross-language recovery**: generic filename/page-count/semantic linking into `variantGroup`; when Arabic text is unclear (broken OCR/missing values), the matching English question (by test/question number) is used to recover values and re-presented in Arabic (marked `recovery.used`).
- **Robust PDF extraction**: Poppler → pdf.js (pure JS) → optional OCR (tesseract.js, `OCR_ENABLED`). No hard dependency on Poppler at runtime; Dockerfile still bundles it.
- **Reliability fix (reported bug)**: `TypeError: fetch failed` was the Qdrant client dropping under the per-question near-dup loop. Added retry/backoff (`rq()`) to all Qdrant calls, made dedup non-fatal + bounded, smaller upsert batches. Large 66-page Arabic PDF now ingests without crashing.
- **Async/background ingestion**: upload returns immediately (no proxy timeout); ingestion runs in a background queue with progress phases (Queued→Extracting→Detecting→Indexing→Completed) via `/rest/ingest-status` and per-source `phase`/`progress`.
- **Source open/download**: `GET /rest/file/:id` (inline) and `?download=1` (attachment) by safe document id; path-traversal-safe (`resolveSourceFile`).
- **MCP OAuth 2.1**: discovery (`/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`), dynamic registration, PKCE authorize, token + refresh (HS256 JWT access tokens). Static `MCP_AUTH_TOKEN` bearer still accepted. 401s send `WWW-Authenticate`.
- **Dashboard**: language tags, tests count, progress/phase, linked variants, error details, Open/Download/Re-index/Delete per source.
- Tests: 39 vitest (unit+features+live e2e) + testing-agent 31/31 backend, 100% frontend.

### Known limitations
- Scanned/image-only Arabic PDFs (e.g. the uploaded 66-page book, whose text layer is mostly a watermark) need `OCR_ENABLED=true` + the optional `tesseract.js` dependency to extract Arabic questions; otherwise only page images + sparse passages are indexed (no crash).
- OAuth `/authorize` auto-approves (single-user private server; no end-user login screen).
- Cross-lingual semantic matching is weak (MiniLM); recovery relies mainly on test/question-number structure.

## Backlog / future
- P1: OCR for scanned (image-only) PDFs (currently text-layer based; figures rendered as page images).
- P1: Per-question figure cropping (currently full page image is returned).
- P2: Quiz session persistence + scoring history surfaced in dashboard.
- P2: Stronger cross-document near-duplicate clustering report in the UI.
- P2: Auth for dashboard REST (currently only `/mcp` is token-protected).
