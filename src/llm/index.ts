import { config } from '../config.js';
import { logger } from '../utils/logger.js';

// Optional LLM used ONLY as a fallback for category/difficulty estimation and
// for reasoning explanations when the source has none. Source-provided answers
// and explanations always take precedence.
export async function llmComplete(system: string, prompt: string): Promise<string | null> {
  try {
    if (config.llm.provider === 'none') return null;

    if (config.llm.provider === 'bridge') {
      if (!config.llm.bridgeUrl) return null;
      const res = await fetch(config.llm.bridgeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ system, prompt, model: config.llm.model }),
      });
      if (!res.ok) {
        logger.warn(`LLM bridge error ${res.status}`);
        return null;
      }
      const json: any = await res.json();
      return (json.text ?? '').toString() || null;
    }

    // openai-compatible
    if (!config.llm.openaiKey) return null;
    const res = await fetch(`${config.llm.openaiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.llm.openaiKey}`,
      },
      body: JSON.stringify({
        model: config.llm.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
      }),
    });
    if (!res.ok) {
      logger.warn(`LLM API error ${res.status}`);
      return null;
    }
    const json: any = await res.json();
    return json.choices?.[0]?.message?.content ?? null;
  } catch (e) {
    logger.warn('LLM call failed', String(e));
    return null;
  }
}

export function llmEnabled(): boolean {
  return config.llm.provider !== 'none';
}
