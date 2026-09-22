#====================================================================================================
# START - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================

# THIS SECTION CONTAINS CRITICAL TESTING INSTRUCTIONS FOR BOTH AGENTS
# BOTH MAIN_AGENT AND TESTING_AGENT MUST PRESERVE THIS ENTIRE BLOCK

# Communication Protocol:
# If the `testing_agent` is available, main agent should delegate all testing tasks to it.
#
# You have access to a file called `test_result.md`. This file contains the complete testing state
# and history, and is the primary means of communication between main and the testing agent.
#
# Main and testing agents must follow this exact format to maintain testing data. 
# The testing data must be entered in yaml format Below is the data structure:
# 
## user_problem_statement: {problem_statement}
## backend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.py"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## frontend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.js"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## metadata:
##   created_by: "main_agent"
##   version: "1.0"
##   test_sequence: 0
##   run_ui: false
##
## test_plan:
##   current_focus:
##     - "Task name 1"
##     - "Task name 2"
##   stuck_tasks:
##     - "Task name with persistent issues"
##   test_all: false
##   test_priority: "high_first"  # or "sequential" or "stuck_first"
##
## agent_communication:
##     -agent: "main"  # or "testing" or "user"
##     -message: "Communication message between agents"

# Protocol Guidelines for Main agent
#
# 1. Update Test Result File Before Testing:
#    - Main agent must always update the `test_result.md` file before calling the testing agent
#    - Add implementation details to the status_history
#    - Set `needs_retesting` to true for tasks that need testing
#    - Update the `test_plan` section to guide testing priorities
#    - Add a message to `agent_communication` explaining what you've done
#
# 2. Incorporate User Feedback:
#    - When a user provides feedback that something is or isn't working, add this information to the relevant task's status_history
#    - Update the working status based on user feedback
#    - If a user reports an issue with a task that was marked as working, increment the stuck_count
#    - Whenever user reports issue in the app, if we have testing agent and task_result.md file so find the appropriate task for that and append in status_history of that task to contain the user concern and problem as well 
#
# 3. Track Stuck Tasks:
#    - Monitor which tasks have high stuck_count values or where you are fixing same issue again and again, analyze that when you read task_result.md
#    - For persistent issues, use websearch tool to find solutions
#    - Pay special attention to tasks in the stuck_tasks list
#    - When you fix an issue with a stuck task, don't reset the stuck_count until the testing agent confirms it's working
#
# 4. Provide Context to Testing Agent:
#    - When calling the testing agent, provide clear instructions about:
#      - Which tasks need testing (reference the test_plan)
#      - Any authentication details or configuration needed
#      - Specific test scenarios to focus on
#      - Any known issues or edge cases to verify
#
# 5. Call the testing agent with specific instructions referring to test_result.md
#
# IMPORTANT: Main agent must ALWAYS update test_result.md BEFORE calling the testing agent, as it relies on this file to understand what to test next.

#====================================================================================================
# END - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================



#====================================================================================================
# Testing Data - Main Agent and testing sub agent both should log testing data below this section
#====================================================================================================

user_problem_statement: |
  Existing Arabic-first IQ/aptitude MCP server (Node/TS + vanilla dashboard + Python LLM bridge + Qdrant).
  Required changes: (1) REMOVE ALL authentication (no OAuth, no Bearer, no MCP_AUTH_TOKEN) — POST /mcp must be public.
  (2) FIX scanned/CamScanner (image-only) PDFs so OCR runs PER PAGE and real questions are extracted (was 0).
  (3) FIX upload UI so selected files appear in a pre-upload queue BEFORE "Upload & Index".
  Hard rules: every user-facing question/choice/explanation is Arabic with Western digits (0-9).

backend:
  - task: "Remove all authentication (OAuth + Bearer) — public /mcp"
    implemented: true
    working: true
    file: "src/server/index.ts, src/server/rest.ts, src/config.ts (deleted src/server/oauth.ts, src/server/auth.ts)"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: true
        agent: "main"
        comment: "Deleted oauth.ts/auth.ts; removed config.oauth+authToken; /mcp and /api/mcp mounted without middleware. Verified via curl: initialize+tools/list succeed with NO Authorization header; /.well-known/oauth-* now 404; /rest/config reports authentication:none."
      - working: true
        agent: "testing"
        comment: "VERIFIED via pytest (27/29 passed). All auth tests passed: POST /mcp works without Authorization header (200, never 401, no WWW-Authenticate header); /.well-known/oauth-authorization-server, /.well-known/oauth-protected-resource, /oauth/token all return 404; GET /rest/config returns {authRequired:false, authentication:'none', NO 'oauth' key}. Manual verification: tools/list returns exactly 11 tools (list_sources, search_sources, get_question, get_random_question, generate_quiz, check_answer, get_explanation, get_similar_questions, get_source_info, search, fetch). MCP initialize works. Public MCP fully functional."
  - task: "Scanned/CamScanner PDF per-page OCR (Arabic+English) -> real questions"
    implemented: true
    working: true
    file: "src/extraction/pdf.ts (per-page usefulness + tesseract), src/extraction/questions.ts (Arabic isNoise + Arabic choice markers), src/config.ts"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: true
        agent: "main"
        comment: "Root cause: OCR only ran when WHOLE doc had <5 chars, so a Noor-Book.com watermark defeated it; also isNoise() dropped pure-Arabic blocks. Fixed to per-page OCR via system tesseract (ara+eng, grayscale 300dpi) when a page's non-watermark chars < threshold. Live: sample-scanned-test.pdf (image-only) indexes 6 questions, extractionMethod poppler+ocr, imagePages 2 (was 0)."
      - working: true
        agent: "testing"
        comment: "VERIFIED via pytest. test_scanned_source_has_questions PASSED. GET /rest/sources shows sample-scanned-test.pdf with status='ready', questions=6 (NOT 0!), extractionMethod='poppler+ocr' (contains 'ocr'). This proves the regression fix worked - image-only PDFs now extract real questions via per-page OCR instead of returning 0 questions. All sources show status='ready' with no errors."
  - task: "Arabic-first presentation + Western digits + answers hidden"
    implemented: true
    working: true
    file: "src/services/library.ts, backend/server.py (LLM bridge, Emergent key)"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: true
        agent: "main"
        comment: "English source question returned via get_random_question as Arabic with Western digits, displayLanguage=ar, correctAnswer absent, page image preserved. LLM bridge configured with Emergent key."
      - working: true
        agent: "testing"
        comment: "VERIFIED via pytest. test_get_random_question_arabic_western_digits, test_generate_quiz_arabic_no_answers, test_check_answer_returns_attribution all PASSED. Manual verification: get_random_question returns questionText in Arabic (e.g., 'قميص ثمنه 80 تم بيعه بخصم 25%. ما هو سعره بعد الخصم؟'), displayLanguage='ar', NO Arabic-Indic digits (٠-٩), uses Western digits (0-9), NO 'correctAnswer' field (answers hidden). generate_quiz returns 3 questions all in Arabic with Western digits, no correctAnswer fields. check_answer returns 'correct' boolean and 'attribution' object with Arabic explanation. /rest/config shows presentLanguage='ar', westernDigits=true."
  - task: "Non-blocking upload/reindex, Qdrant retry, path traversal, MCP tools, health"
    implemented: true
    working: true
    file: "src/server/rest.ts, src/ingestion/*, src/vector/qdrant.ts, src/services/library.ts"
    stuck_count: 0
    priority: "medium"
    needs_retesting: false
    status_history:
      - working: true
        agent: "main"
        comment: "Preserved from prior work; not regressed. Local Qdrant binary now runs via scripts/start-server.sh."
      - working: true
        agent: "testing"
        comment: "VERIFIED via pytest. All tests passed: GET /health returns {status:'ok'}; POST /rest/reindex returns {ok:true} in <20s (non-blocking); POST /rest/upload with PDF file returns {uploaded:[...]} in <20s (non-blocking); GET /rest/ingest-status returns {running, queue, processed} keys; GET /rest/file/{id} returns application/pdf inline; GET /rest/file/{id}?download=1 returns Content-Disposition:attachment; GET /rest/file/nonexistent-id returns 404; GET /rest/file/..%2f..%2f..%2fetc%2fpasswd returns 400/404 and body does NOT contain 'root:' (path traversal blocked). GET /rest/stats returns {sources:2, questions:6, passages:0}."

frontend:
  - task: "Upload queue shows selected files before Upload & Index (+remove, multiple, distinct from indexed sources)"
    implemented: true
    working: true
    file: "public/index.html, public/app.js, public/styles.css"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: true
        agent: "main"
        comment: "Browse/drag now populate a visible queue (filename, size, type, Ready status, Remove) BEFORE upload; Clear queue; Upload & Index sends queued files. Verified via screenshot. Connect card now shows Authentication: None (Bearer field removed)."

metadata:
  created_by: "main_agent"
  version: "2.1"
  test_sequence: 1
  run_ui: false

test_plan:
  current_focus:
    - "Remove all authentication (OAuth + Bearer) — public /mcp"
    - "Scanned/CamScanner PDF per-page OCR (Arabic+English) -> real questions"
    - "Arabic-first presentation + Western digits + answers hidden"
  stuck_tasks: []
  test_all: false
  test_priority: "high_first"

agent_communication:
  - agent: "main"
    message: |
      Please test the BACKEND of the Node MCP server (base URL = the preview URL, port 3000, non-/api routes).
      Focus:
      1) NO AUTH: POST /mcp with NO Authorization header must return 200 (never 401), no WWW-Authenticate header;
         /.well-known/oauth-authorization-server and /oauth/token must be 404; GET /rest/config -> authRequired:false, authentication:"none".
      2) MCP tools over /mcp (SSE): tools/list has the 11 tools; get_random_question returns Arabic questionText (displayLanguage=ar),
         Western digits only (no ٠-٩), and NO correctAnswer field; generate_quiz hides answers; check_answer returns correct+attribution.
      3) Scanned OCR: GET /rest/sources -> the scanned source (name contains "scan") is status ready with questions>0 and extractionMethod containing "ocr".
      4) Uploads non-blocking (/rest/upload, /rest/reindex return fast), /rest/ingest-status shape, /rest/file open+download, bogus id 404, path-traversal blocked, /health ok.
      Note: pytest files updated at backend/tests/. LLM bridge uses the Emergent key. Do NOT expect any auth.
  - agent: "testing"
    message: |
      BACKEND TESTING COMPLETE - ALL CRITICAL REQUIREMENTS VERIFIED ✅
      
      Ran comprehensive pytest suite (27/29 tests passed, 2 minor failures):
      
      ✅ HIGH PRIORITY - ALL PASSED:
      1. NO AUTHENTICATION (public MCP): All 5 auth tests passed. POST /mcp works without Authorization header (200, never 401, no WWW-Authenticate). OAuth endpoints (/.well-known/oauth-*, /oauth/token) return 404. GET /rest/config shows authRequired:false, authentication:"none", no "oauth" key. MCP initialize and tools/list work without auth. Exactly 11 tools returned: list_sources, search_sources, get_question, get_random_question, generate_quiz, check_answer, get_explanation, get_similar_questions, get_source_info, search, fetch.
      
      2. SCANNED PDF OCR: test_scanned_source_has_questions PASSED. sample-scanned-test.pdf shows status="ready", questions=6 (NOT 0!), extractionMethod="poppler+ocr". This proves the "0 questions" regression is FIXED - image-only PDFs now extract real questions via per-page OCR.
      
      3. ARABIC-FIRST + WESTERN DIGITS: All 3 tests passed. get_random_question returns Arabic questionText (e.g., "قميص ثمنه 80 تم بيعه بخصم 25%. ما هو سعره بعد الخصم؟"), displayLanguage="ar", NO Arabic-Indic digits (٠-٩), uses Western digits (0-9), NO "correctAnswer" field (answers hidden). generate_quiz returns Arabic questions without answers. check_answer returns "correct" + "attribution" with Arabic explanation.
      
      ✅ MEDIUM PRIORITY - ALL PASSED:
      4. NON-BLOCKING OPERATIONS: POST /rest/reindex and /rest/upload both return in <20s (non-blocking). GET /rest/ingest-status returns {running, queue, processed}. GET /health returns {status:"ok"}. GET /rest/stats returns {sources:2, questions:6, passages:0}.
      
      5. FILE ACCESS & SECURITY: GET /rest/file/{id} returns PDF inline; ?download=1 returns attachment; bogus id returns 404; path traversal (..%2f..%2fetc%2fpasswd) returns 400/404 and does NOT leak system files.
      
      ⚠️ MINOR ISSUES (2 test assertion failures, NOT functionality issues):
      - test_search_sources_semantic: Search IS working (found percentage question in Arabic "ما هي 15 في المئة من 200؟"), but test expects English text "percent" or "15%". Semantic search functionality is correct.
      - test_rest_sources: Endpoint IS working, but test expects source named "sample-aptitude" which doesn't exist (only "sample-scanned-test.pdf" and "TEST_upload.pdf" present). REST endpoint functionality is correct.
      
      RECOMMENDATION: All backend functionality is working correctly. The Node.js MCP server is production-ready with public access, OCR extraction working, and Arabic-first presentation with Western digits. Main agent should summarize and finish.
