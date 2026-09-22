"""Backend tests for the Node.js IQ Aptitude MCP server."""
import json
import os
import re
import time
import pytest
import requests

BASE_URL = os.environ.get(
    "TEST_BASE_URL",
    "https://c49cdfce-0e72-4e90-aa82-e94635eab524.preview.emergentagent.com",
)

HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
}


def parse_sse(text):
    """Extract JSON from SSE 'data:' lines."""
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    for line in normalized.split("\n"):
        if line.startswith("data:"):
            payload = line[5:].strip()
            if payload:
                return json.loads(payload)
    return json.loads(text)


def mcp_call(method, params=None, req_id=1):
    body = {"jsonrpc": "2.0", "id": req_id, "method": method}
    if params is not None:
        body["params"] = params
    r = requests.post(f"{BASE_URL}/mcp", headers=HEADERS, json=body, timeout=60)
    return r


def tool_call(name, arguments):
    r = mcp_call("tools/call", {"name": name, "arguments": arguments}, req_id=42)
    assert r.status_code == 200, f"tool {name} HTTP {r.status_code}: {r.text[:400]}"
    data = parse_sse(r.content.decode("utf-8"))
    assert "result" in data, f"No result: {data}"
    content = data["result"]["content"]
    text_block = next(b for b in content if b.get("type") == "text")
    return json.loads(text_block["text"]), data["result"]


# ---------------- Health ----------------
def test_health():
    r = requests.get(f"{BASE_URL}/health", timeout=15)
    assert r.status_code == 200
    j = r.json()
    assert j.get("status") == "ok"


# ---------------- No authentication (public MCP) ----------------
def test_mcp_is_public_no_auth():
    r = requests.post(
        f"{BASE_URL}/mcp",
        headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream"},
        json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "c", "version": "1"}}},
        timeout=15,
    )
    assert r.status_code == 200
    assert r.status_code != 401


# ---------------- Handshake ----------------
def test_mcp_initialize():
    r = mcp_call("initialize", {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "c", "version": "1"}})
    assert r.status_code == 200
    data = parse_sse(r.text)
    assert "result" in data
    assert data["result"].get("protocolVersion")


# ---------------- Tools list ----------------
REQUIRED_TOOLS = {
    "list_sources", "search_sources", "get_question", "get_random_question",
    "generate_quiz", "check_answer", "get_explanation", "get_similar_questions", "get_source_info",
}


def test_tools_list():
    # Some MCP servers require initialize first in same session, try direct
    r = mcp_call("tools/list", {})
    assert r.status_code == 200, r.text[:400]
    data = parse_sse(r.text)
    tools = {t["name"] for t in data["result"]["tools"]}
    missing = REQUIRED_TOOLS - tools
    assert not missing, f"Missing tools: {missing}"


# ---------------- Semantic search ----------------
def test_search_sources_semantic():
    parsed, _ = tool_call("search_sources", {"query": "a difficult percentage question", "limit": 3})
    results = parsed.get("results") or parsed.get("hits") or []
    # Semantic search must return results (content is Arabic-first, so we do NOT
    # assert on English keywords). Each result should carry attribution.
    assert isinstance(results, list) and len(results) >= 1, f"no search results: {parsed}"
    assert any(r.get("questionText") for r in results if isinstance(r, dict)), f"no questionText: {results}"


# ---------------- Random question hides answer ----------------
def test_get_random_question_no_answer():
    parsed, _ = tool_call("get_random_question", {})
    q = parsed.get("question") or parsed
    assert "correctAnswer" not in json.dumps(q).split('"correctAnswer"')[0] or '"correctAnswer"' not in json.dumps(q)
    # simpler: ensure key absent
    assert "correctAnswer" not in json.dumps(q)
    # store id for later test
    qid = q.get("id") or (parsed.get("question") or {}).get("id")
    assert qid, f"no id in {parsed}"


# ---------------- Quiz ----------------
def test_generate_quiz_no_answers():
    parsed, _ = tool_call("generate_quiz", {"number_of_questions": 3})
    questions = parsed.get("questions")
    assert isinstance(questions, list) and len(questions) >= 1
    for q in questions:
        assert "correctAnswer" not in q, f"Quiz question leaked answer: {q}"


# ---------------- Check answer ----------------
def test_check_answer():
    parsed, _ = tool_call("get_random_question", {})
    q = parsed.get("question") or parsed
    qid = q.get("id")
    assert qid
    parsed2, _ = tool_call("check_answer", {"questionId": qid, "user_answer": "A"})
    assert "correct" in parsed2, parsed2
    assert "attribution" in parsed2, parsed2


# ---------------- REST endpoints (used by dashboard) ----------------
def test_rest_config():
    r = requests.get(f"{BASE_URL}/rest/config", timeout=15)
    assert r.status_code == 200
    j = r.json()
    assert "mcpUrl" in j or "endpoint" in j or "url" in j


def test_rest_stats():
    r = requests.get(f"{BASE_URL}/rest/stats", timeout=15)
    assert r.status_code == 200
    j = r.json()
    # expect some counts
    assert isinstance(j, dict)


def test_rest_sources():
    r = requests.get(f"{BASE_URL}/rest/sources", timeout=15)
    assert r.status_code == 200
    j = r.json()
    items = j if isinstance(j, list) else j.get("sources", [])
    # Generic: at least one indexed source exists (no hardcoded source name).
    assert len(items) >= 1, f"no sources indexed; got {items}"
