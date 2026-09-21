# IQ / Aptitude Trainer — MCP Server

Turn **your own** IQ / aptitude / reasoning PDFs into a private, interactive training
knowledge base that ChatGPT can use as an MCP connector. Upload any legally-obtained
PDFs, and the server ingests, indexes and exposes them through semantic search and a set
of training tools — **no code changes needed to add new sources**.

> This project is **completely generic**. It is not tied to any book, author, publisher
> or named test. Upload different sources later and the same server keeps working.

- **MCP over Streamable HTTP** at `POST /mcp` (Bearer-token protected) — connectable to ChatGPT.
- **Vector search** with **Qdrant** + embeddings (offline local model by default, or OpenAI).
- **PDF ingestion** with page numbers, section/category/difficulty detection, and duplicate detection.
- **Image-based questions**: pages with figures/matrices/shapes are rendered and returned so
  ChatGPT never has to guess missing visual information.
- **Web dashboard** to upload, view, search, re-index, delete sources and inspect extracted questions.
- **Docker / docker-compose** with persistent storage. Tests + a sample document included.

---

## 1. Architecture

```
src/
  server/      Express app, MCP endpoint (Streamable HTTP), auth, REST API
  tools/       (MCP tools are registered in server/mcp.ts)
  ingestion/   ingest pipeline + source manager (new/changed/deleted detection)
  extraction/  PDF text/page-image extraction (poppler) + question segmentation
  embeddings/  pluggable embedder (local @xenova/transformers | OpenAI)
  vector/      Qdrant client wrapper (collection, upsert, search, scroll, filter)
  database/    JSON registry for documents + quizzes (questions live in Qdrant)
  services/    library.ts — business logic shared by tools + dashboard
  llm/         optional LLM (category/difficulty estimation, reasoning fallback)
scripts/       ingest.ts, reindex.ts, warmup.ts, make-sample.ts
public/        web dashboard (static)
sources/       drop your PDFs here
data/          Qdrant/embedding cache, rendered page images, registry (persistent)
```

Questions are stored as vectors **with full payload** (source, page, section, category,
difficulty, choices, answer, explanation, image refs) directly in Qdrant. A small JSON
registry tracks documents and file hashes.

---

## 2. Install

**Requirements:** Node.js >= 20, and [`poppler-utils`](https://poppler.freedesktop.org/)
(`pdftotext`, `pdftoppm`, `pdfimages`) on the host. A running **Qdrant** instance.

```bash
# system dependency (Debian/Ubuntu)
sudo apt-get install -y poppler-utils      # macOS: brew install poppler

# project dependencies
yarn install
```

---

## 3. Configure environment variables

Copy the example and edit:

```bash
cp .env.example .env
```

| Variable | Purpose |
|---|---|
| `PORT`, `HOST` | Server bind address (default `3000`). |
| `PUBLIC_BASE_URL` | Public HTTPS base used to build image URLs and the MCP URL shown in the dashboard. |
| `MCP_AUTH_TOKEN` | **Bearer token** required for `POST /mcp`. Use a long random string. Empty = auth disabled. |
| `SOURCES_DIR`, `DATA_DIR` | Where PDFs and indexed data live. |
| `QDRANT_URL`, `QDRANT_API_KEY`, `QDRANT_COLLECTION` | Vector database connection. |
| `EMBEDDING_PROVIDER` | `local` (offline, default) or `openai`. |
| `LOCAL_EMBEDDING_MODEL`, `TRANSFORMERS_CACHE` | Local model + cache dir. |
| `OPENAI_API_KEY`, `OPENAI_EMBEDDING_MODEL`, `OPENAI_BASE_URL` | Used only when `EMBEDDING_PROVIDER=openai`. |
| `LLM_PROVIDER` | `none` (heuristics only), `openai`, or `bridge`. Used for category/difficulty estimation and reasoning **only when the source has none**. |
| `LLM_MODEL`, `LLM_BRIDGE_URL` | LLM model + bridge endpoint (for `bridge`). |
| `CHUNK_MAX_CHARS`, `CHUNK_OVERLAP_CHARS`, `EMBED_BATCH_SIZE` | Ingestion tuning. |
| `RENDER_PAGE_IMAGES`, `IMAGE_DPI` | Render page images for figure-based questions. |
| `AUTO_INGEST` | Watch `sources/` and auto-index new/changed PDFs. |

> **Never** expose API keys through MCP responses — the server does not, and only the
> configured `SOURCES_DIR` is ever accessed (no arbitrary filesystem access).

---

## 4. Start the vector database (Qdrant)

**Docker (recommended):**

```bash
docker run -p 6333:6333 -p 6334:6334 -v $(pwd)/data/qdrant:/qdrant/storage qdrant/qdrant
```

Or use the bundled `docker-compose.yml` (below) which starts Qdrant + the server together.

---

## 5. Add PDFs

Two ways — **no code changes required**:

1. **Dashboard:** open the web UI and drag-and-drop PDFs (or click *browse*).
2. **Filesystem:** copy files into `sources/`:
   ```
   sources/
     book1.pdf
     book2.pdf
   ```

With `AUTO_INGEST=true`, files dropped into `sources/` are detected and indexed automatically.

To try it without your own files, generate the included generic sample:

```bash
yarn make-sample     # writes sources/sample-aptitude-test.pdf
```

---

## 6. Index PDFs

```bash
yarn ingest          # index new / changed files in sources/
```

The pipeline extracts text (preserving page numbers), segments questions, detects choices /
answer keys / explanations / categories / difficulty, renders page images for figure-based
questions, embeds everything and upserts into Qdrant. Duplicates and near-duplicates are
skipped. Document hashes are stored so unchanged files are not re-processed.

## 7. Re-index

```bash
yarn reindex         # force a full re-index of every source
```

Changing a file (new hash) re-indexes **only that file**. Deleting a file from `sources/`
removes its vectors on the next sync. You can also re-index / delete individual sources from
the dashboard.

## 8. Run the MCP server

```bash
yarn start           # production
yarn dev             # watch mode
```

Endpoints:
- `POST /mcp` — MCP Streamable HTTP (Bearer token required)
- `GET  /health` — health check
- `/` — web dashboard
- `/rest/*` — dashboard REST API, `/rest/images/*` — rendered page images

---

## 9. Connect to ChatGPT

In ChatGPT, add a **custom connector / MCP server** (Developer mode / Connectors):

- **URL:** `https://YOUR-DOMAIN/mcp`
- **Auth:** Bearer token -> the value of `MCP_AUTH_TOKEN`

The dashboard's *Connect to ChatGPT* card shows the exact URL and header. Once connected,
ChatGPT can call the tools below.

### MCP tools

| Tool | Description |
|---|---|
| `list_sources` | All uploaded/indexed sources. |
| `search_sources` | Semantic search (`query`, optional `source`/`category`/`difficulty`/`limit`). |
| `get_question` | A suitable question (optionally filtered); returned **without** the answer. |
| `get_random_question` | A random question (optionally filtered). |
| `generate_quiz` | `number_of_questions` (+ filters) -> structured quiz, answers omitted. |
| `check_answer` | Verifies an answer, **preferring the source's own answer/explanation**. |
| `get_explanation` | Source-first explanation/solution for a question. |
| `get_similar_questions` | Similar questions to a given id/text. |
| `get_source_info` | Metadata + detected sections/categories for a source. |
| `search` / `fetch` | ChatGPT connector-compatibility aliases. |

**Training behaviour:** the server returns questions *without* answers so ChatGPT can present
them, wait for your answer, then call `check_answer` and explain — using the source's own
answer key/explanation whenever available, and a clearly-labelled AI fallback otherwise.
Figure-based questions return the page image so nothing has to be guessed.

---

## 10. Deploy publicly over HTTPS

### Option A — Docker Compose (server + Qdrant)

```bash
cp .env.example .env         # set MCP_AUTH_TOKEN and PUBLIC_BASE_URL
docker compose up -d --build
```

This starts Qdrant (persistent volume) and the MCP server on `PORT` with `./sources` and
`./data` mounted as volumes. Put it behind a TLS reverse proxy (Caddy / Nginx / Traefik) so
that `https://YOUR-DOMAIN/mcp` and `https://YOUR-DOMAIN/health` are served over HTTPS.

Example Caddy:
```
your-domain.com {
    reverse_proxy localhost:3000
}
```

### Option B — Any Node host

1. Provision Node >= 20 and `poppler-utils`.
2. Set env vars (point `QDRANT_URL` at your Qdrant, set `MCP_AUTH_TOKEN`, `PUBLIC_BASE_URL`).
3. `yarn install && yarn warmup && yarn start` behind an HTTPS reverse proxy.

Health check for load balancers: `GET /health`.

---

## 11. Add additional sources later

Just upload more PDFs (dashboard or `sources/`) and they are indexed automatically — the
system stays generic. Remove a source from the dashboard (or delete the file) to drop it.

---

## Tests

```bash
yarn test
```

- **Unit tests** (no external services): question extraction, page-spanning questions,
  answer-key parsing, chunking, category/difficulty classification, duplicate hashing,
  vector math, answer checking, and PDF extraction (when the sample exists).
- **Live e2e tests**: health endpoint, MCP auth, `tools/list`, semantic search, question
  retrieval, quiz generation and answer checking against a running server. These **skip
  automatically** if the server isn't reachable, so unit tests still run in isolation.

Set `TEST_BASE_URL` / `MCP_AUTH_TOKEN` to point the e2e tests at a specific instance.

---

## Notes on copyright & attribution

The server returns only the **minimum** text needed (the question itself), never bulk
document dumps, and preserves internal attribution (`source`, `page`, `section`) on every
result. Answer-key/solution pages are excluded from generic passage search. It prefers the
source's own answer/explanation over any model-generated content.

## Running in the Emergent preview environment

In this hosted preview the server runs on port `3000` (exposed as the public preview URL),
Qdrant runs locally on `6333`, and the optional LLM uses a small Python bridge
(`backend/server.py`, `LLM_PROVIDER=bridge`) backed by the Emergent Universal Key. For a
normal deployment set `LLM_PROVIDER=none` or `openai` and use the Docker Compose setup above.

## License

MIT
