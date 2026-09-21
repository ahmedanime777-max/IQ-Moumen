# Test Credentials & Access

## MCP endpoint (Bearer-token protected)
- URL (preview): https://logic-engine-23.preview.emergentagent.com/mcp
- Local: http://localhost:3000/mcp
- Auth header: `Authorization: Bearer iq-mcp-local-dev-token-9f3a2b7c`
  (value = `MCP_AUTH_TOKEN` in /app/.env)

## Dashboard (no login)
- https://logic-engine-23.preview.emergentagent.com/  (open, no auth)

## Services
- Node MCP+dashboard server: port 3000 (supervisor `frontend` -> tsx src/server/index.ts)
- Qdrant: http://localhost:6333 (supervisor `qdrant`)
- Python LLM bridge: http://localhost:8001/api/llm/complete (supervisor `backend`)

## Notes
- No user accounts in this app. The only secret is the MCP Bearer token above.
- Sample data: sources/sample-aptitude-test.pdf (generated via `yarn make-sample`).
