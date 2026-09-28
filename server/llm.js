/* llm.js — optional OpenAI-compatible brain for roster residents.
 *
 * Disabled unless LLM_API_KEY is set. Callers keep the rule-based
 * chatBrain reply when this returns null (no key, HTTP error, timeout,
 * or an empty completion). Never log the key.
 */
'use strict';

function enabled() {
  return Boolean(process.env.LLM_API_KEY);
}

function persona(agent, islandName) {
  return [
    'You are ' + (agent.name || 'a resident') + ', a resident of ' + (islandName || 'Dawnbreak') + '.',
    'Personality: ' + (agent.personality || 'easygoing') + '.',
    'Right now you are ' + (agent.activity || 'wandering') + '.',
    'Reply in one or two short spoken sentences, under 240 characters.',
    'Do not mention being an AI, a model, or a prompt.',
  ].join(' ');
}

async function complete(agent, userText, islandName, fetchImpl) {
  if (!enabled()) return null;
  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') return null;
  const base = String(process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = process.env.LLM_MODEL || 'gpt-4o-mini';
  const timeoutMs = Number(process.env.LLM_TIMEOUT_MS || 8000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number.isFinite(timeoutMs) ? timeoutMs : 8000);
  try {
    const res = await fetchFn(base + '/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: 'Bearer ' + process.env.LLM_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.7,
        max_tokens: 120,
        messages: [
          { role: 'system', content: persona(agent, islandName) },
          { role: 'user', content: String(userText || '').slice(0, 500) },
        ],
      }),
    });
    if (!res || !res.ok) return null;
    const data = await res.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text) return null;
    const cleaned = String(text).trim().slice(0, 500);
    return cleaned || null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { enabled, complete, persona };
