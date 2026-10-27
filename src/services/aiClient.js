// Sends instructions (with one file, a picture or PDF, or none) to the
// configured AI and returns the JSON it answers: Google Gemini when
// GEMINI_API_KEY is set, otherwise an OpenAI-compatible endpoint (OCR_AI_URL,
// OCR_AI_API_KEY).

function parseJson(text) {
  if (!text) throw new Error('AI returned no analysis.');
  return JSON.parse(text.replace(/^```json\s*|\s*```$/g, '').trim());
}

// An AI failure. retryable: false when trying the same file again cannot help
// (the service refused the file itself); busy, unreachable and retired models
// are retryable, and the scan retry queue reads the file again later.
export class AiUnavailableError extends Error {
  constructor(message, { retryable = true } = {}) {
    super(message);
    this.name = 'AiUnavailableError';
    this.retryable = retryable;
  }
}

const BUSY_MESSAGE = 'The AI service is busy right now. The document was saved and will be read again automatically.';
const UNREACHABLE_MESSAGE = 'The AI service could not be reached. The document was saved and will be read again automatically.';

// Waits between rounds of tries inside one request when every model was busy
// (OCR_AI_RETRY_DELAYS_MS, e.g. "2000,5000"; empty for none). Later retries
// are made by the scan retry queue (see retryDueScans).
const retryDelays = () => String(process.env.OCR_AI_RETRY_DELAYS_MS ?? '2000,5000').split(',')
  .map((value) => Number(value.trim())).filter((value) => Number.isFinite(value) && value > 0);
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

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
  if (!apiKey) throw new AiUnavailableError('The OCR/AI service is not configured. Set GEMINI_API_KEY or OCR_AI_API_KEY on the server.');

  const deadline = Date.now() + AI_TIME_BUDGET_MS;
  const body = JSON.stringify({
    model: process.env.OCR_AI_MODEL || 'gpt-4o-mini', temperature, response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content }],
  });
  let busy = false;
  for (const delay of [0, ...retryDelays()]) {
    if (delay) {
      if (deadline - Date.now() < delay + 5000) break;
      await sleep(delay);
    }
    let response;
    try {
      response = await fetch(endpoint, {
        signal: AbortSignal.timeout(Math.max(3000, deadline - Date.now())),
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body,
      });
    } catch {
      busy = false;
      continue;
    }
    if (response.ok) {
      const reply = (await response.json())?.choices?.[0]?.message?.content;
      return parseJson(Array.isArray(reply) ? reply.map((part) => part.text || '').join('') : reply);
    }
    if (response.status !== 429 && response.status < 500) throw new AiUnavailableError(`AI service returned ${response.status}.`, { retryable: response.status !== 400 });
    busy = true;
  }
  throw new AiUnavailableError(busy ? BUSY_MESSAGE : UNREACHABLE_MESSAGE);
}

// Google retires Gemini models over time (gemini-2.5-flash now answers 404
// "no longer available") and models are sometimes overloaded (503/429). The
// configured model is tried first, then these, all within one time budget so
// the request finishes before the 60-second serverless limit. An overloaded
// model can also hang without answering, so each try gets at most
// AI_ATTEMPT_MS and the older, less busy models still get their turn.
const GEMINI_FALLBACK_MODELS = ['gemini-3.8-flash', 'gemini-flash-latest', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash',
  'gemini-flash-lite-latest', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
const AI_TIME_BUDGET_MS = 45000;
const AI_ATTEMPT_MS = 15000;

// A model that just failed is rested so the next scans do not wait on it
// again: busy or hanging models for a few minutes, retired ones for a day.
// The model that answered last is tried first. Rested models still come last
// in the list, so a scan is never refused only because all of them are resting.
const REST_MS = { busy: 5 * 60000, timeout: 5 * 60000, unavailable: 5 * 60000, network: 60000, unreadable: 60000, retired: 24 * 3600000 };
const restingUntil = new Map();
let lastWorkingModel = null;

// When a model answers 404 (a wrong or retired model name), the models this
// API key can use are listed (at most every 6 hours) and the Flash models
// among them are added after the fallbacks, newest first, so a retired name
// in GEMINI_MODEL or in the list above does not stop the scanner.
const DISCOVERY_MS = 6 * 3600000;
let discovered = { at: 0, models: [] };

const geminiBase = () => process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta';

// "gemini-3.8-flash" -> [3, 8]; the "-latest" aliases sort first, Lite models after the others.
const modelVersion = (name) => (/-latest$/.test(name) ? [99] : (/gemini-(\d+(?:\.\d+)*)/.exec(name)?.[1] || '0').split('.').map(Number));
function newestFirst(a, b) {
  const [left, right] = [modelVersion(a), modelVersion(b)];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if ((left[index] || 0) !== (right[index] || 0)) return (right[index] || 0) - (left[index] || 0);
  }
  return Number(a.includes('lite')) - Number(b.includes('lite'));
}

async function discoverModels(apiKey) {
  if (Date.now() - discovered.at < DISCOVERY_MS) return discovered.models;
  discovered = { at: Date.now(), models: [] };
  try {
    const response = await fetch(`${geminiBase()}/models?pageSize=1000`, { signal: AbortSignal.timeout(5000), headers: { 'x-goog-api-key': apiKey } });
    const payload = response.ok ? await response.json() : {};
    const models = (Array.isArray(payload?.models) ? payload.models : [])
      .filter((model) => Array.isArray(model?.supportedGenerationMethods) && model.supportedGenerationMethods.includes('generateContent'))
      .map((model) => String(model.name || '').replace(/^models\//, ''))
      .filter((name) => /^gemini-.*flash/.test(name) && !/(image|tts|audio|live|embedding|thinking|exp)/.test(name))
      .sort(newestFirst);
    discovered = { at: Date.now(), models };
    if (models.length) console.warn(`Gemini models available to this API key: ${models.slice(0, 8).join(', ')}`);
  } catch (error) {
    console.warn('Could not list the Gemini models:', error instanceof Error ? error.message : error);
  }
  return discovered.models;
}

function modelsToTry() {
  const now = Date.now();
  const all = [...new Set([lastWorkingModel, process.env.GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS, ...discovered.models].filter(Boolean))];
  const resting = (model) => (restingUntil.get(model) || 0) > now;
  return [...all.filter((model) => !resting(model)),
    ...all.filter(resting).sort((a, b) => restingUntil.get(a) - restingUntil.get(b))];
}

function rest(model, problem) {
  restingUntil.set(model, Date.now() + REST_MS[problem]);
  if (lastWorkingModel === model) lastWorkingModel = null;
}

// parts: the instruction, then the file (if any) as inlineData. unreadable is
// the message for a 400 answer (the request itself was refused).
// Every model is tried in turn; when none answered and time is left, they are
// all tried again after a short wait (2 s, then 5 s by default).
async function askGemini(apiKey, systemPrompt, parts, { temperature, unreadable }) {
  const deadline = Date.now() + AI_TIME_BUDGET_MS;
  const body = JSON.stringify({
    generationConfig: { temperature, responseMimeType: 'application/json' },
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ parts }],
  });

  // Models that answered 404 in this request are not tried again in it.
  const retired = new Set();
  let lastProblem = 'unavailable';
  for (const delay of [0, ...retryDelays()]) {
    if (delay) {
      if (deadline - Date.now() < delay + 5000) break;
      await sleep(delay);
    }
    const models = modelsToTry().filter((model) => !retired.has(model));
    if (!models.length) break;
    for (let index = 0; index < models.length; index += 1) {
      const model = models[index];
      const remaining = deadline - Date.now();
      if (remaining < 3000) break;
      let response;
      try {
        response = await fetch(`${geminiBase()}/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST', signal: AbortSignal.timeout(Math.min(remaining, AI_ATTEMPT_MS)), headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body,
        });
      } catch (error) {
        lastProblem = error?.name === 'TimeoutError' ? 'timeout' : 'network';
        console.warn(`Gemini ${model} ${lastProblem}:`, error instanceof Error ? error.message : error);
        rest(model, lastProblem);
        continue;
      }
      if (response.ok) {
        // A model that answers with broken JSON is skipped like a busy one.
        try {
          const payload = await response.json();
          const answer = parseJson(payload?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join(''));
          lastWorkingModel = model;
          restingUntil.delete(model);
          return answer;
        } catch (error) {
          console.warn(`Gemini ${model} gave an unreadable answer:`, error instanceof Error ? error.message : error);
          lastProblem = 'unavailable';
          rest(model, 'unreadable');
          continue;
        }
      }
      const detail = (await response.json().catch(() => ({})))?.error?.message || '';
      console.warn(`Gemini ${model} returned ${response.status}: ${String(detail).slice(0, 200)}`);
      if (response.status === 401 || response.status === 403) throw new AiUnavailableError('The AI service rejected the API key. Check GEMINI_API_KEY on the server.');
      if (response.status === 400) throw new AiUnavailableError(unreadable, { retryable: false });
      if (response.status === 404) {
        retired.add(model);
        if (model === process.env.GEMINI_MODEL) console.warn(`GEMINI_MODEL "${model}" is not available (404). Update GEMINI_MODEL on the server; other models are used meanwhile.`);
        const listed = new Set(models);
        for (const found of await discoverModels(apiKey)) if (!listed.has(found) && !retired.has(found)) models.push(found);
      }
      lastProblem = response.status === 404 ? 'retired' : response.status === 429 ? 'busy' : 'unavailable';
      rest(model, lastProblem);
    }
  }
  throw new AiUnavailableError(lastProblem === 'busy' || lastProblem === 'unavailable' || lastProblem === 'timeout' ? BUSY_MESSAGE : UNREACHABLE_MESSAGE);
}

// Lets the tests start from a clean slate of rested and discovered models.
export function resetAiModelStateForTesting() {
  restingUntil.clear();
  lastWorkingModel = null;
  discovered = { at: 0, models: [] };
}

// Why the AI could not answer, without the "will be read again" note meant for scans.
export const aiFailureReason = (error) => (error instanceof Error ? error.message.replace(/\s*The document was saved.*$/, '') : 'AI analysis failed.').slice(0, 300);
