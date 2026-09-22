"""Backend tests for new features: OAuth 2.1, Arabic-first, non-blocking upload/reindex, source file, path traversal."""
import base64
import hashlib
import io
import json
import os
import re
import secrets
import time
from urllib.parse import urlparse, parse_qs

import pytest
import requests

BASE_URL = "https://logic-engine-23.preview.emergentagent.com"
STATIC_TOKEN = "iq-mcp-local-dev-token-9f3a2b7c"

ARABIC_RE = re.compile(r"[\u0600-\u06FF]")
AR_INDIC_DIGITS_RE = re.compile(r"[\u0660-\u0669\u06F0-\u06F9]")


def parse_sse(text):
    # SSE spec splits on \n or \r\n only, but Python's splitlines() also splits on
    # U+2028/U+000B etc which may appear inside Arabic/JSON strings. Use plain split.
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    for line in normalized.split("\n"):
        if line.startswith("data:"):
            payload = line[5:].strip()
            if payload:
                return json.loads(payload)
    return json.loads(text)


def mcp_call(method, params=None, token=STATIC_TOKEN, req_id=1):
    body = {"jsonrpc": "2.0", "id": req_id, "method": method}
    if params is not None:
        body["params"] = params
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return requests.post(f"{BASE_URL}/mcp", headers=headers, json=body, timeout=120)


def tool_call(name, arguments, token=STATIC_TOKEN):
    r = mcp_call("tools/call", {"name": name, "arguments": arguments}, token=token, req_id=42)
    assert r.status_code == 200, f"{name} HTTP {r.status_code}: {r.text[:300]}"
    body = r.content.decode("utf-8")
    data = parse_sse(body)
    assert "result" in data, data
    content = data["result"]["content"]
    text_block = next(b for b in content if b.get("type") == "text")
    return json.loads(text_block["text"])


# ---------------- Health ----------------
def test_health():
    r = requests.get(f"{BASE_URL}/health", timeout=15)
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


# ---------------- OAuth discovery ----------------
def test_oauth_discovery_as():
    r = requests.get(f"{BASE_URL}/.well-known/oauth-authorization-server", timeout=15)
    assert r.status_code == 200
    j = r.json()
    for k in ("issuer", "authorization_endpoint", "token_endpoint", "registration_endpoint"):
        assert k in j, f"missing {k}"


def test_oauth_discovery_pr():
    r = requests.get(f"{BASE_URL}/.well-known/oauth-protected-resource", timeout=15)
    assert r.status_code == 200
    j = r.json()
    assert "resource" in j
    assert "authorization_servers" in j and isinstance(j["authorization_servers"], list)


# ---------------- OAuth full flow ----------------
def _pkce():
    verifier = secrets.token_urlsafe(64)[:64]
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    return verifier, challenge


@pytest.fixture(scope="module")
def oauth_tokens():
    # register
    reg = requests.post(
        f"{BASE_URL}/oauth/register",
        json={"client_name": "TEST_client", "redirect_uris": ["https://example.com/cb"]},
        timeout=15,
    )
    assert reg.status_code in (200, 201), reg.text
    client_id = reg.json()["client_id"]

    verifier, challenge = _pkce()
    # authorize (no redirect follow)
    az = requests.get(
        f"{BASE_URL}/oauth/authorize",
        params={
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": "https://example.com/cb",
            "state": "xyz",
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        },
        allow_redirects=False,
        timeout=15,
    )
    assert az.status_code in (302, 303), f"authorize status {az.status_code}: {az.text[:300]}"
    loc = az.headers["Location"]
    q = parse_qs(urlparse(loc).query)
    assert "code" in q and q["state"][0] == "xyz"
    code = q["code"][0]

    # token exchange
    tok = requests.post(
        f"{BASE_URL}/oauth/token",
        data={
            "grant_type": "authorization_code",
            "code": code,
            "code_verifier": verifier,
            "redirect_uri": "https://example.com/cb",
            "client_id": client_id,
        },
        timeout=15,
    )
    assert tok.status_code == 200, tok.text
    tj = tok.json()
    assert "access_token" in tj and "refresh_token" in tj and "expires_in" in tj
    return {"client_id": client_id, "verifier": verifier, **tj}


def test_oauth_full_flow(oauth_tokens):
    assert oauth_tokens["access_token"]
    assert oauth_tokens["refresh_token"]


def test_oauth_refresh(oauth_tokens):
    r = requests.post(
        f"{BASE_URL}/oauth/token",
        data={
            "grant_type": "refresh_token",
            "refresh_token": oauth_tokens["refresh_token"],
            "client_id": oauth_tokens["client_id"],
        },
        timeout=15,
    )
    assert r.status_code == 200, r.text
    assert r.json().get("access_token")


def test_oauth_invalid_code(oauth_tokens):
    r = requests.post(
        f"{BASE_URL}/oauth/token",
        data={
            "grant_type": "authorization_code",
            "code": "bogus-code-xyz",
            "code_verifier": oauth_tokens["verifier"],
            "redirect_uri": "https://example.com/cb",
            "client_id": oauth_tokens["client_id"],
        },
        timeout=15,
    )
    assert r.status_code in (400, 401), r.status_code
    assert r.json().get("error") == "invalid_grant", r.json()


# ---------------- MCP auth backwards compat + OAuth token ----------------
def test_mcp_static_token_works():
    r = mcp_call("tools/list", {}, token=STATIC_TOKEN)
    assert r.status_code == 200
    tools = {t["name"] for t in parse_sse(r.text)["result"]["tools"]}
    assert {"list_sources", "search_sources", "get_question", "get_random_question",
            "generate_quiz", "check_answer", "get_explanation",
            "get_similar_questions", "get_source_info"} <= tools


def test_mcp_oauth_token_works(oauth_tokens):
    r = mcp_call("tools/list", {}, token=oauth_tokens["access_token"])
    assert r.status_code == 200, r.text[:300]
    tools = parse_sse(r.text)["result"]["tools"]
    assert len(tools) >= 9


def test_mcp_no_token_returns_401():
    r = mcp_call("tools/list", {}, token=None)
    assert r.status_code == 401
    assert "www-authenticate" in {k.lower() for k in r.headers.keys()}


# ---------------- Non-blocking upload / reindex ----------------
def _tiny_pdf_bytes():
    # Minimal valid single-page PDF
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
    j = r.json()
    assert j.get("ok") is True, j
    assert elapsed < 20, f"reindex blocked for {elapsed:.1f}s"


def test_upload_is_nonblocking():
    _wait_ingest_idle()
    files = {"files": ("TEST_upload.pdf", _tiny_pdf_bytes(), "application/pdf")}
    t0 = time.time()
    r = requests.post(f"{BASE_URL}/rest/upload", files=files, timeout=30)
    elapsed = time.time() - t0
    assert r.status_code == 200, f"{r.status_code}: {r.text[:300]}"
    j = r.json()
    assert "uploaded" in j, j
    assert elapsed < 20, f"upload blocked for {elapsed:.1f}s"


def test_ingest_status():
    r = requests.get(f"{BASE_URL}/rest/ingest-status", timeout=30)
    assert r.status_code == 200
    j = r.json()
    for k in ("running", "queue", "processed"):
        assert k in j, f"missing {k} in {j}"


# ---------------- Sources ready (no 'error') ----------------
def test_sources_ready_no_error():
    # Allow indexing to settle first (reindex may have been triggered by earlier tests)
    _wait_ingest_idle(max_wait=240)
    r = requests.get(f"{BASE_URL}/rest/sources", timeout=20)
    assert r.status_code == 200
    j = r.json()
    items = j if isinstance(j, list) else j.get("sources", [])
    assert items, "no sources"
    errored = [s for s in items if str(s.get("status", "")).lower() == "error"]
    assert not errored, f"sources in error: {[(s.get('filename') or s.get('name'), s.get('status')) for s in errored]}"
    # Look for the large Arabic source
    noor = [s for s in items if "noor" in (s.get("filename") or s.get("name") or "").lower()]
    if noor:
        n = noor[0]
        assert str(n.get("status")).lower() == "ready", f"Noor source not ready: {n}"
        img_pages = n.get("imagePages") or n.get("image_pages") or 0
        assert img_pages > 0, f"Noor imagePages not >0: {n}"


# ---------------- Source open/download + path traversal ----------------
@pytest.fixture(scope="module")
def any_source_id():
    r = requests.get(f"{BASE_URL}/rest/sources", timeout=20)
    items = r.json() if isinstance(r.json(), list) else r.json().get("sources", [])
    assert items
    sid = items[0].get("id") or items[0].get("_id") or items[0].get("sourceId")
    assert sid
    return sid


def test_file_open_inline(any_source_id):
    r = requests.get(f"{BASE_URL}/rest/file/{any_source_id}", timeout=30)
    assert r.status_code == 200, r.status_code
    ctype = r.headers.get("Content-Type", "").lower()
    assert "application/pdf" in ctype, f"unexpected content-type: {ctype}"


def test_file_download(any_source_id):
    r = requests.get(f"{BASE_URL}/rest/file/{any_source_id}", params={"download": "1"}, timeout=30)
    assert r.status_code == 200
    disp = r.headers.get("Content-Disposition", "").lower()
    assert "attachment" in disp, f"expected attachment, got: {disp}"


def test_file_bogus_returns_404():
    r = requests.get(f"{BASE_URL}/rest/file/nonexistent-id-xyz", timeout=15)
    assert r.status_code == 404


def test_path_traversal_blocked():
    r = requests.get(f"{BASE_URL}/rest/file/..%2f..%2f..%2fetc%2fpasswd", timeout=15)
    # Cloudflare WAF may return 400 before hitting our server; either way file must not be served
    assert r.status_code in (400, 404), r.status_code
    assert "root:" not in r.text


# ---------------- Arabic-first + Western digits ----------------
def _has_arabic(s):
    return bool(ARABIC_RE.search(s or ""))


def _no_arabic_indic_digits(s):
    return not AR_INDIC_DIGITS_RE.search(s or "")


def test_get_random_question_arabic_western_digits():
    # Try several times to skip passages
    found = None
    for _ in range(6):
        parsed = tool_call("get_random_question", {})
        q = parsed.get("question") or parsed
        qtext = q.get("questionText") or q.get("question_text") or ""
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
    # get a non-passage question
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
