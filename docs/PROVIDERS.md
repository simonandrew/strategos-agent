# LLM Provider Configuration

Configure your provider by setting three environment variables before running the agent. Copy `.env.example` to `.env` and fill in the block for your provider.

---

## Anthropic (Claude)

Get your API key at [console.anthropic.com](https://console.anthropic.com).

```bash
LLM_BASE_URL=https://api.anthropic.com/v1
LLM_API_KEY=sk-ant-...
LLM_MODEL=claude-haiku-4-5-20251001
```

**Recommended models:**
- `claude-haiku-4-5-20251001` — fastest, cheapest, fully capable for strategy
- `claude-sonnet-4-6` — stronger reasoning, better for complex diplomatic strategies

---

## OpenAI (GPT)

Get your API key at [platform.openai.com](https://platform.openai.com).

```bash
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4o-mini
```

**Recommended models:**
- `gpt-4o-mini` — fast, cheap, good default
- `gpt-4o` — stronger reasoning

---

## Grok (xAI)

Get your API key at [console.x.ai](https://console.x.ai).

```bash
LLM_BASE_URL=https://api.x.ai/v1
LLM_API_KEY=xai-...
LLM_MODEL=grok-2-latest
```

---

## Groq

Fast hosted inference. Get your API key at [console.groq.com](https://console.groq.com).

```bash
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_API_KEY=gsk_...
LLM_MODEL=llama-3.3-70b-versatile
```

**Recommended models:**
- `llama-3.3-70b-versatile` — strong reasoning, very fast
- `mixtral-8x7b-32768` — fast and cheap

---

## LM Studio (local)

Download [LM Studio](https://lmstudio.ai), load a model, and start the local server. No API key required.

```bash
LLM_BASE_URL=http://localhost:1234/v1
LLM_API_KEY=lm-studio
LLM_MODEL=lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF
LLM_JSON_MODE=true
```

Set `LLM_JSON_MODE=true` — smaller local models are more reliable with JSON output than function calling.

**Recommended models in LM Studio:**
- `Meta-Llama-3.1-8B-Instruct` — good balance of speed and capability
- `Mistral-7B-Instruct` — fast, works well for structured output
- `Qwen2.5-14B-Instruct` — strong reasoning for a local model

---

## Ollama (local)

Install [Ollama](https://ollama.ai) and pull a model. No API key required.

```bash
ollama pull llama3.2
```

```bash
LLM_BASE_URL=http://localhost:11434/v1
LLM_API_KEY=ollama
LLM_MODEL=llama3.2
LLM_JSON_MODE=true
```

**Recommended models:**
- `llama3.2` — fast, good for strategy
- `mistral` — reliable JSON output
- `qwen2.5:14b` — stronger reasoning

---

## JSON mode

Set `LLM_JSON_MODE=true` for providers or models that don't support function calling reliably. The agent requests a JSON object directly instead of using tool calls. Most cloud providers don't need this; most small local models do.

```bash
LLM_JSON_MODE=true
```

---

## Testing your provider

After configuring, run a quick health check:

```bash
# Start the agent (will connect and log tick output)
npx tsx agent.ts --server http://... --season ... --token ... --nation ...

# In another terminal, check the management API
curl http://localhost:3001/health
```

The health endpoint returns the active model, base URL, and json_mode status:

```json
{
  "ok": true,
  "model": "gpt-4o-mini",
  "base_url": "https://api.openai.com/v1",
  "json_mode": false
}
```
