"""Backend tests: NO authentication (public MCP), Arabic-first + Western digits,
scanned-PDF OCR question counts, non-blocking upload/reindex, source file access,
and path-traversal protection."""
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

ARABIC_RE = re.compile(r"[\u0600-\u06FF]")
AR_INDIC_DIGITS_RE = re.compile(r"[\u0660-\u0669\u06F0-\u06F9]")


def parse_sse(text):
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    for line in normalized.split("\n"):
        if line.startswith("data:"):
            payload = line[5:].strip()
            if payload:
                return json.loads(payload)
    return json.loads(text)


def mcp_call(method, params=None, with_auth=False, req_id=1):
    """Call the MCP endpoint. By default sends NO Authorization header, because
    the endpoint must be public (no OAuth, no Bearer token)."""
    body = {"jsonrpc": "2.0", "id": req_id, "method": method}
    if params is not None:
        body["params"] = params
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    if with_auth:  # only used to prove auth is IGNORED, never required
        headers["Authorization"] = "Bearer anything-should-be-ignored"
    return requests.post(f"{BASE_URL}/mcp", headers=headers, json=body, timeout=120)


def tool_call(name, arguments):
    r = mcp_call("tools/call", {"name": name, "arguments": arguments}, req_id=42)
    assert r.status_code == 200, f"{name} HTTP {r.status_code}: {r.text[:300]}"
    data = parse_sse(r.content.decode("utf-8"))
    assert "result" in data, data
    content = data["result"]["content"]
    text_block = next(b for b in content if b.get("type") == "text")
    return json.loads(text_block["text"])


# ---------------- Health ----------------
def test_health():
    r = requests.get(f"{BASE_URL}/health", timeout=15)
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


# ---------------- No authentication ----------------
def test_mcp_works_without_any_auth():
    r = mcp_call("tools/list", {})
    assert r.status_code == 200, r.text[:300]
    tools = {t["name"] for t in parse_sse(r.text)["result"]["tools"]}
    assert {
        "list_sources", "search_sources", "get_question", "get_random_question",
        "generate_quiz", "check_answer", "get_explanation",
        "get_similar_questions", "get_source_info",
    } <= tools


def test_mcp_never_returns_401():
    # No token -> must NOT be rejected, and must NOT send a WWW-Authenticate header.
    r = mcp_call("tools/list", {})
    assert r.status_code != 401
    assert "www-authenticate" not in {k.lower() for k in r.headers.keys()}


def test_no_oauth_discovery_endpoints():
    for path in (
        "/.well-known/oauth-authorization-server",
        "/.well-known/oauth-protected-resource",
        "/.well-known/openid-configuration",
    ):
        r = requests.get(f"{BASE_URL}{path}", timeout=15)
        assert r.status_code == 404, f"{path} should be gone, got {r.status_code}"


def test_no_oauth_token_endpoint():
    r = requests.post(f"{BASE_URL}/oauth/token", data={"grant_type": "authorization_code"}, timeout=15)
    assert r.status_code == 404


def test_config_reports_no_auth():
    r = requests.get(f"{BASE_URL}/rest/config", timeout=15)
    assert r.status_code == 200
    j = r.json()
    assert j.get("authRequired") is False
    assert j.get("authentication") == "none"
    assert "oauth" not in j


# ---------------- Non-blocking upload / reindex ----------------
def _tiny_pdf_bytes():
    return (
        b"%PDF-1.4\n"
        b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
        b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
        b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n"
        b"4 0 obj<</Length 44>>stream\nBT /F1 12 Tf 20 100 Td (Hello Test) Tj ET\nendstream endobj\n"
        b"5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n"
        b"xref\n0 6\n0000000000 65535 f \n0000000010 00000 n \n0000000053 00000 n \n0000000096 00000 n \n0000000185 00000 n \n0000000265 00000 n \n"
        b"trailer<</Size 6/Root 1 0 R>>\nstartxref\n325\n%%EOF\n"
    )


def _wait_ingest_idle(max_wait=180):
    start = time.time()
    while time.time() - start < max_wait:
        try:
            r = requests.get(f"{BASE_URL}/rest/ingest-status", timeout=10)
            if r.status_code == 200 and not r.json().get("running"):
                return True
        except Exception:
            pass
        time.sleep(3)
    return False


def test_reindex_is_nonblocking():
    _wait_ingest_idle()
    t0 = time.time()
    r = requests.post(f"{BASE_URL}/rest/reindex", json={}, timeout=25)
    elapsed = time.time() - t0
    assert r.status_code == 200, r.text[:300]
    assert r.json().get("ok") is True
    assert elapsed < 20, f"reindex blocked for {elapsed:.1f}s"


def test_upload_is_nonblocking():
    _wait_ingest_idle()
    files = {"files": ("TEST_upload.pdf", _tiny_pdf_bytes(), "application/pdf")}
    t0 = time.time()
    r = requests.post(f"{BASE_URL}/rest/upload", files=files, timeout=30)
    elapsed = time.time() - t0
    assert r.status_code == 200, f"{r.status_code}: {r.text[:300]}"
    assert "uploaded" in r.json()
    assert elapsed < 20, f"upload blocked for {elapsed:.1f}s"


def test_ingest_status():
    r = requests.get(f"{BASE_URL}/rest/ingest-status", timeout=30)
    assert r.status_code == 200
    j = r.json()
    for k in ("running", "queue", "processed"):
        assert k in j, f"missing {k} in {j}"


# ---------------- Scanned PDF -> questions extracted (NOT zero) ----------------
def test_scanned_source_has_questions():
    """A scanned/image-only PDF must report a non-zero question count via OCR."""
    _wait_ingest_idle(max_wait=240)
    r = requests.get(f"{BASE_URL}/rest/sources", timeout=20)
    assert r.status_code == 200
    items = r.json() if isinstance(r.json(), list) else r.json().get("sources", [])
    assert items, "no sources"
    scanned = [s for s in items if "scan" in (s.get("name") or "").lower()]
    if scanned:
        s = scanned[0]
        assert str(s.get("status")).lower() == "ready", s
        assert (s.get("questions") or 0) > 0, f"scanned source extracted 0 questions: {s}"
        method = (s.get("extractionMethod") or "").lower()
        assert "ocr" in method, f"expected OCR extraction method, got {method!r}"


def test_sources_ready_no_error():
    _wait_ingest_idle(max_wait=240)
    r = requests.get(f"{BASE_URL}/rest/sources", timeout=20)
    assert r.status_code == 200
    items = r.json() if isinstance(r.json(), list) else r.json().get("sources", [])
    assert items, "no sources"
    errored = [s for s in items if str(s.get("status", "")).lower() == "error"]
    assert not errored, f"sources in error: {[(s.get('name'), s.get('error')) for s in errored]}"


# ---------------- Source open/download + path traversal ----------------
@pytest.fixture(scope="module")
def any_source_id():
    r = requests.get(f"{BASE_URL}/rest/sources", timeout=20)
    items = r.json() if isinstance(r.json(), list) else r.json().get("sources", [])
    assert items
    sid = items[0].get("id")
    assert sid
    return sid


def test_file_open_inline(any_source_id):
    r = requests.get(f"{BASE_URL}/rest/file/{any_source_id}", timeout=30)
    assert r.status_code == 200
    assert "application/pdf" in r.headers.get("Content-Type", "").lower()


def test_file_download(any_source_id):
    r = requests.get(f"{BASE_URL}/rest/file/{any_source_id}", params={"download": "1"}, timeout=30)
    assert r.status_code == 200
    assert "attachment" in r.headers.get("Content-Disposition", "").lower()


def test_file_bogus_returns_404():
    r = requests.get(f"{BASE_URL}/rest/file/nonexistent-id-xyz", timeout=15)
    assert r.status_code == 404


def test_path_traversal_blocked():
    r = requests.get(f"{BASE_URL}/rest/file/..%2f..%2f..%2fetc%2fpasswd", timeout=15)
    assert r.status_code in (400, 404), r.status_code
    assert "root:" not in r.text


# ---------------- Arabic-first + Western digits ----------------
def _has_arabic(s):
    return bool(ARABIC_RE.search(s or ""))


def _no_arabic_indic_digits(s):
    return not AR_INDIC_DIGITS_RE.search(s or "")


def test_get_random_question_arabic_western_digits():
    found = None
    for _ in range(6):
        parsed = tool_call("get_random_question", {})
        q = parsed.get("question") or parsed
        qtext = q.get("questionText") or ""
        if _has_arabic(qtext):
            found = (parsed, q, qtext)
            break
        time.sleep(0.5)
    assert found, "No Arabic questionText obtained after retries"
    parsed, q, qtext = found
    assert _no_arabic_indic_digits(qtext), f"Arabic-Indic digits present: {qtext!r}"
    assert (q.get("displayLanguage") or parsed.get("displayLanguage")) == "ar"


def test_generate_quiz_arabic_no_answers():
    parsed = tool_call("generate_quiz", {"number_of_questions": 3})
    questions = parsed.get("questions")
    assert isinstance(questions, list) and questions
    for q in questions:
        assert "correctAnswer" not in q, f"answer leaked: {q}"
        qtext = q.get("questionText") or ""
        assert _has_arabic(qtext), f"non-Arabic quiz question: {qtext!r}"
        assert _no_arabic_indic_digits(qtext)


def test_check_answer_returns_attribution():
    qid = None
    for _ in range(6):
        parsed = tool_call("get_random_question", {})
        q = parsed.get("question") or parsed
        if q.get("id"):
            qid = q["id"]
            break
    assert qid
    parsed2 = tool_call("check_answer", {"questionId": qid, "user_answer": "A"})
    assert "correct" in parsed2
    assert "attribution" in parsed2
    expl = parsed2.get("explanation")
    if expl:
        assert _has_arabic(expl), f"explanation not Arabic: {expl!r}"
