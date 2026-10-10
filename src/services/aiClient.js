// Sends instructions (with one file, a picture or PDF, or none) to the
// configured AI and returns the JSON it answers: Google Gemini when
// GEMINI_API_KEY is set, otherwise an OpenAI-compatible endpoint (OCR_AI_URL,
// OCR_AI_API_KEY).

function parseJson(text) {
  if (!text) throw new Error('AI returned no analysis.');
  return JSON.parse(text.replace(/^```json\s*|\s*```$/g, '').trim());
}

// Sends one file with its instructions to the AI and returns the JSON it answers.
export async function askAi(file, systemPrompt, instruction) {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    return askGemini(geminiKey, systemPrompt, [{ text: instruction }, { inlineData: { mimeType: file.mimetype, data: file.buffer.toString('base64') } }],
      { temperature: 0, unreadable: 'The AI service could not read this file. Try a clearer photo or a PDF.' });
  }

  const base64 = file.buffer.toString('base64');
  const dataUrl = `data:${file.mimetype};base64,${base64}`;
  const content = [{ type: 'text', text: `${instruction} Return JSON only.` }];
  if (file.mimetype.startsWith('image/')) content.push({ type: 'image_url', image_url: { url: dataUrl, detail: 'high' } });
  else content.push({ type: 'text', text: `The uploaded file is a PDF named ${file.originalname}. Use the available document input capability to inspect it.` });
  return askOpenAiCompatible(systemPrompt, content, 0);
}

// Asks the AI with no file, e.g. for the machinery recommendations in
// Analytics; the same services, models and fallbacks as askAi.
export async function askAiText(systemPrompt, instruction, { temperature = 0.2 } = {}) {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) return askGemini(geminiKey, systemPrompt, [{ text: instruction }], { temperature, unreadable: 'The AI service could not answer this request.' });
  return askOpenAiCompatible(systemPrompt, `${instruction} Return JSON only.`, temperature);
}

async function askOpenAiCompatible(systemPrompt, content, temperature) {
  const endpoint = process.env.OCR_AI_URL || 'https://api.openai.com/v1/chat/completions';
  const apiKey = process.env.OCR_AI_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('The OCR/AI service is not configured. Set GEMINI_API_KEY or OCR_AI_API_KEY on the server.');

  const response = await fetch(endpoint, {
    signal: AbortSignal.timeout(45000),
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: process.env.OCR_AI_MODEL || 'gpt-4o-mini', temperature, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content }],
    }),
  });
  if (!response.ok) throw new Error(response.status === 429 || response.status >= 500 ? 'The AI service is busy right now. The document was saved; press Retry in a minute.' : `AI service returned ${response.status}.`);
  const reply = (await response.json())?.choices?.[0]?.message?.content;
  return parseJson(Array.isArray(reply) ? reply.map((part) => part.text || '').join('') : reply);
}

// Google retires Gemini models over time (gemini-2.5-flash now answers 404
// "no longer available") and models are sometimes overloaded (503/429). The
// configured model is tried first, then these, all within one time budget so
// the request finishes before the 60-second serverless limit.
const GEMINI_FALLBACK_MODELS = ['gemini-3.8-flash', 'gemini-flash-latest', 'gemini-3.7-flash'];
const AI_TIME_BUDGET_MS = 45000;

// parts: the instruction, then the file (if any) as inlineData. unreadable is
// the message for a 400 answer (the request itself was refused).
async function askGemini(apiKey, systemPrompt, parts, { temperature, unreadable }) {
  const models = [...new Set([process.env.GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS].filter(Boolean))];
  const deadline = Date.now() + AI_TIME_BUDGET_MS;
  const body = JSON.stringify({
    generationConfig: { temperature, responseMimeType: 'application/json' },
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ parts }],
  });

  let lastProblem = 'unavailable';
  for (const model of models) {
    const remaining = deadline - Date.now();
    if (remaining < 3000) break;
    let response;
    try {
      response = await fetch(`${process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta'}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', signal: AbortSignal.timeout(remaining), headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body,
      });
    } catch (error) {
      lastProblem = error?.name === 'TimeoutError' ? 'timeout' : 'network';
      console.warn(`Gemini ${model} ${lastProblem}:`, error instanceof Error ? error.message : error);
      continue;
    }
    if (response.ok) {
      const payload = await response.json();
      return parseJson(payload?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join(''));
    }
    const detail = (await response.json().catch(() => ({})))?.error?.message || '';
    console.warn(`Gemini ${model} returned ${response.status}: ${String(detail).slice(0, 200)}`);
    if (response.status === 401 || response.status === 403) throw new Error('The AI service rejected the API key. Check GEMINI_API_KEY on the server.');
    if (response.status === 400) throw new Error(unreadable);
    lastProblem = response.status === 404 ? 'retired' : response.status === 429 ? 'busy' : 'unavailable';
  }
  throw new Error(lastProblem === 'busy' || lastProblem === 'unavailable' || lastProblem === 'timeout'
    ? 'The AI service (Google Gemini) is busy right now. The document was saved; press Retry in a minute.'
    : 'The AI service could not be reached. The document was saved; press Retry in a minute.');
}

// Why the AI could not answer, without the "press Retry" advice meant for scans.
export const aiFailureReason = (error) => (error instanceof Error ? error.message.replace(/\s*The document was saved.*$/, '') : 'AI analysis failed.').slice(0, 300);
