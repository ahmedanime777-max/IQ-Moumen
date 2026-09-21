"""
Minimal LLM bridge for the IQ/Aptitude MCP server (Emergent environment only).

The Node MCP server calls POST /api/llm/complete when LLM_PROVIDER=bridge, which
routes to an Emergent Universal Key model via `emergentintegrations`. This is used
purely as a fallback for category/difficulty estimation and reasoning explanations
when the uploaded source has no answer key / explanation. Source-provided answers
always take precedence inside the Node service.
"""
import os
import logging
from pathlib import Path

from fastapi import FastAPI, APIRouter
from starlette.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from pydantic import BaseModel

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("llm-bridge")

EMERGENT_LLM_KEY = os.environ.get("EMERGENT_LLM_KEY", "")

app = FastAPI(title="IQ MCP LLM Bridge")
api = APIRouter(prefix="/api")


class CompleteRequest(BaseModel):
    system: str = "You are a helpful assistant."
    prompt: str
    model: str = "gpt-4o"
    provider: str = "openai"


@api.get("/health")
async def health():
    return {"status": "ok", "llm_key_configured": bool(EMERGENT_LLM_KEY)}


@api.post("/llm/complete")
async def complete(req: CompleteRequest):
    if not EMERGENT_LLM_KEY:
        return {"text": "", "error": "EMERGENT_LLM_KEY not configured"}
    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage
        import uuid

        chat = LlmChat(
            api_key=EMERGENT_LLM_KEY,
            session_id=f"iq-mcp-{uuid.uuid4()}",
            system_message=req.system,
        ).with_model(req.provider, req.model)
        text = await chat.send_message(UserMessage(text=req.prompt))
        return {"text": text if isinstance(text, str) else str(text)}
    except Exception as e:  # noqa: BLE001
        logger.exception("LLM bridge error")
        return {"text": "", "error": str(e)}


app.include_router(api)
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)
