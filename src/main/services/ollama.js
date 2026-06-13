// Client for a local Ollama server running Gemma (or any chat model).
// Uses /api/chat with structured outputs: passing a JSON schema as `format`
// makes Ollama constrain sampling to valid JSON — reliable classification
// even from small local models.

export function createOllama(getSettings) {
  async function request(path, init, timeoutMs) {
    const { ollamaUrl } = getSettings();
    const url = `${String(ollamaUrl).replace(/\/+$/, '')}${path}`;
    let res;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new Error(`Cannot reach Ollama at ${url}: ${e.cause?.message || e.message}. Is \`ollama serve\` running?`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let detail = text;
      try { detail = JSON.parse(text).error || text; } catch { /* plain text */ }
      throw new Error(`Ollama ${path} → HTTP ${res.status}: ${detail}`);
    }
    return res.json();
  }

  return {
    /**
     * One chat completion. `schema` (optional) is a JSON schema enforcing the
     * response shape. Returns the raw content string.
     */
    async chat({ messages, schema, temperature } = {}) {
      const s = getSettings();
      const settingsTemp = Number(s.temperature);
      const body = {
        model: s.ollamaModel,
        messages,
        stream: false,
        options: {
          num_ctx: Number(s.numCtx) || 16384,
          temperature: temperature ?? (Number.isFinite(settingsTemp) ? settingsTemp : 0.2),
        },
      };
      if (schema) body.format = schema;
      const json = await request('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }, 600000); // local models can be slow; generous timeout
      const content = json?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw new Error(`Ollama returned an empty response from model "${s.ollamaModel}"`);
      }
      return content;
    },

    async listModels() {
      const json = await request('/api/tags', { method: 'GET' }, 8000);
      return (json.models || []).map((m) => m.name);
    },

    async health() {
      const s = getSettings();
      try {
        const models = await this.listModels();
        const hasModel = models.some((m) => m === s.ollamaModel || m.split(':')[0] === s.ollamaModel.split(':')[0]);
        return { ok: true, models, model: s.ollamaModel, hasModel };
      } catch (e) {
        return { ok: false, error: e.message, model: s.ollamaModel };
      }
    },
  };
}
