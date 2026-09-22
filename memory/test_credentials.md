# Test Credentials & Access

## Authentication: NONE
This app has **no authentication**. There are no user accounts, no OAuth, and no Bearer
token. The MCP endpoint is fully public.

## MCP endpoint (public — no auth header)
- URL (preview): https://c49cdfce-0e72-4e90-aa82-e94635eab524.preview.emergentagent.com/mcp
- Local: http://localhost:3000/mcp
- Connect ChatGPT directly to the URL — do NOT set any Authorization header.

## Dashboard (no login)
- https://c49cdfce-0e72-4e90-aa82-e94635eab524.preview.emergentagent.com/

## Services
- Node MCP + dashboard server: port 3000 (supervisor `frontend` -> scripts/start-server.sh -> tsx src/server/index.ts)
- Qdrant: http://localhost:6333 (started by scripts/start-server.sh)
- Python LLM bridge: http://localhost:8001/api/llm/complete (supervisor `backend`, Emergent LLM key)

## Notes
- No secrets are required to use the API.
- Sample data: `sources/sample-scanned-test.pdf` (image-only OCR demo, via `tsx scripts/make-scanned-sample.ts`).
- Optional text sample: `yarn make-sample` -> `sources/sample-aptitude-test.pdf`.
