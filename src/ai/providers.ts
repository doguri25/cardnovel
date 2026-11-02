// One adapter for three providers. Calls go straight from the browser to each provider with the user's own key.
import type { TextProvider } from '../model';

export type AiErrorCode =
  | 'no_key' | 'invalid_key' | 'forbidden' | 'rate_limited' | 'overloaded' | 'refused'
  | 'too_large' | 'invalid_json' | 'empty' | 'network' | 'upstream' | 'cancelled' | 'bad_request';

export class AiError extends Error {
  constructor(public code: AiErrorCode, message = '', public status = 0) { super(message || code); }
}

export const AI_MESSAGES: Record<AiErrorCode, string> = {
  no_key: 'API 키가 없어요. 설정에서 키를 넣어 주세요.',
  invalid_key: 'API 키가 맞지 않아요. 설정에서 키를 확인해 주세요.',
  forbidden: '이 키로는 이 모델을 쓸 권한이 없어요.',
  rate_limited: '요청이 너무 잦거나 사용 한도에 닿았어요. 잠시 뒤 다시 해 주세요.',
  overloaded: 'AI 서버가 붐벼요. 잠시 뒤 다시 해 주세요.',
  refused: '이 내용으로는 만들 수 없었어요. 문장을 바꿔 보세요.',
  too_large: '입력이 너무 길어요. 내용을 줄여 주세요.',
  invalid_json: '형식이 어긋난 답이 왔어요. 한 번 더 눌러 주세요.',
  empty: '답이 비어 있었어요. 다시 해 주세요.',
  network: '인터넷 연결을 확인해 주세요.',
  upstream: 'AI 서버와 연결이 잠시 끊겼어요. 다시 해 주세요.',
  cancelled: '중단했어요.',
  bad_request: '요청이 받아들여지지 않았어요.',
};
export const aiMessage = (e: unknown): string => {
  if (e instanceof AiError) return AI_MESSAGES[e.code] + (e.code === 'bad_request' && e.message ? ` (${e.message.slice(0, 140)})` : '');
  return AI_MESSAGES.upstream;
};

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new AiError('cancelled')); }, { once: true });
});

function classify(status: number, body: unknown): AiError {
  const b = body as { error?: { type?: string; message?: string; status?: string; code?: string } } | null;
  const msg = b?.error?.message || '';
  const type = (b?.error?.type || b?.error?.status || b?.error?.code || '').toString();
  if (status === 401 || /authentication|API key not valid|invalid_api_key|API_KEY_INVALID/i.test(msg + type)) return new AiError('invalid_key', msg, status);
  if (status === 403 || /PERMISSION_DENIED|permission/i.test(type)) return new AiError('forbidden', msg, status);
  if (status === 429 || /rate_limit|RESOURCE_EXHAUSTED|insufficient_quota/i.test(type)) return new AiError('rate_limited', msg, status);
  if (status === 529 || /overloaded/i.test(type)) return new AiError('overloaded', msg, status);
  if (status === 413 || /too long|too large|maximum context|context length|prompt is too long/i.test(msg)) return new AiError('too_large', msg, status);
  if (status >= 500) return new AiError('upstream', msg, status);
  return new AiError('bad_request', msg, status);
}

/** fetch with retries for busy servers (429, 5xx), cancellable. */
async function call(url: string, init: RequestInit, signal?: AbortSignal, retries = 2): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal });
    } catch (e) {
      if (signal?.aborted) throw new AiError('cancelled');
      if (attempt < retries) { await sleep(1500 * (attempt + 1), signal); continue; }
      throw new AiError('network', String(e));
    }
    let body: unknown = null;
    const text = await res.text();
    try { body = text ? JSON.parse(text) : null; } catch { body = { error: { message: text.slice(0, 300) } }; }
    if (res.ok) return body;
    const err = classify(res.status, body);
    const retryable = ['rate_limited', 'overloaded', 'upstream'].includes(err.code) && !/insufficient_quota/i.test(err.message);
    if (retryable && attempt < retries) {
      const ra = Number(res.headers.get('retry-after'));
      await sleep(ra > 0 && ra < 30 ? ra * 1000 : 2000 * (attempt + 1) ** 2, signal);
      continue;
    }
    throw err;
  }
}

/** Takes the JSON object out of a model's text answer (fences, leading words). */
export function extractJSON(text: string): unknown {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch { /* fall through */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* fall through */ } }
  throw new AiError('invalid_json');
}

/* ================= model lists ================= */
export interface ModelInfo { id: string; label: string }

const ANTHROPIC = 'https://api.anthropic.com/v1';
const OPENAI = 'https://api.openai.com/v1';
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';

const anthropicHeaders = (key: string) => ({
  'x-api-key': key,
  'anthropic-version': '2023-06-01',
  'anthropic-dangerous-direct-browser-access': 'true',
  'content-type': 'application/json',
});
const openaiHeaders = (key: string) => ({ Authorization: `Bearer ${key}`, 'content-type': 'application/json' });
const geminiHeaders = (key: string) => ({ 'x-goog-api-key': key, 'content-type': 'application/json' });

const geminiScore = (id: string) => {
  const v = parseFloat((id.match(/(\d+(?:\.\d+)?)/) || ['0'])[0]);
  const tier = /pro/.test(id) ? 3 : /flash-lite|lite/.test(id) ? 1 : /flash/.test(id) ? 2 : 0;
  const unstable = /preview|exp/.test(id) ? -0.5 : 0;
  return v * 10 + tier + unstable;
};

export interface ModelLists { text: ModelInfo[]; image: ModelInfo[] }

export async function listModels(provider: TextProvider, key: string, signal?: AbortSignal): Promise<ModelLists> {
  if (!key) throw new AiError('no_key');
  if (provider === 'anthropic') {
    const r = (await call(`${ANTHROPIC}/models?limit=100`, { headers: anthropicHeaders(key) }, signal)) as { data?: { id: string; display_name?: string }[] };
    const text = (r.data ?? []).map((m) => ({ id: m.id, label: m.display_name || m.id }));
    return { text, image: [] };
  }
  if (provider === 'openai') {
    const r = (await call(`${OPENAI}/models`, { headers: openaiHeaders(key) }, signal)) as { data?: { id: string; created?: number }[] };
    const all = (r.data ?? []).sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
    const text = all
      .filter((m) => /^(gpt-|o\d)/.test(m.id) && !/(image|audio|realtime|tts|transcribe|search|embedding|instruct|moderation|codex|computer-use)/.test(m.id))
      .map((m) => ({ id: m.id, label: m.id }));
    const image = all.filter((m) => /^gpt-image/.test(m.id)).map((m) => ({ id: m.id, label: m.id }));
    return { text, image };
  }
  const r = (await call(`${GEMINI}/models?pageSize=1000`, { headers: geminiHeaders(key) }, signal)) as {
    models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[];
  };
  const gen = (r.models ?? []).filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'));
  const id = (m: { name: string }) => m.name.replace(/^models\//, '');
  const isImage = (m: { name: string }) => /(image|banana)/.test(id(m)) && !/imagen/.test(id(m));
  const text = gen
    .filter((m) => /gemini/.test(id(m)) && !isImage(m) && !/(tts|embedding|live|audio|robotics|computer-use)/.test(id(m)))
    .sort((a, b) => geminiScore(id(b)) - geminiScore(id(a)))
    .map((m) => ({ id: id(m), label: m.displayName || id(m) }));
  const image = gen.filter(isImage).sort((a, b) => geminiScore(id(b)) - geminiScore(id(a))).map((m) => ({ id: id(m), label: m.displayName || id(m) }));
  return { text, image };
}

/** A sensible default when the user has not picked a model yet. */
export function pickDefault(provider: TextProvider | 'geminiImage' | 'openaiImage', list: ModelInfo[]): string {
  if (!list.length) return '';
  const ids = list.map((m) => m.id);
  if (provider === 'anthropic') return ids.find((i) => /sonnet/.test(i)) ?? ids[0];
  if (provider === 'openai') return ids.find((i) => /^gpt-\d/.test(i) && !/(mini|nano)/.test(i)) ?? ids[0];
  if (provider === 'google') return ids.find((i) => /flash/.test(i) && !/lite|preview|exp/.test(i)) ?? ids[0];
  return ids[0];
}

/* ================= text ================= */
export interface TextRequest {
  provider: TextProvider;
  key: string;
  model: string;
  system: string;
  prompt: string;
  /** JSON schema (OpenAI strict-mode compatible) when a JSON answer is wanted */
  schema?: Record<string, unknown>;
  maxTokens?: number;
  signal?: AbortSignal;
}

export async function generateText(req: TextRequest): Promise<string> {
  const { provider, key, model, system, prompt, maxTokens = 16000, signal } = req;
  if (!key) throw new AiError('no_key');
  if (!model) throw new AiError('bad_request', '모델을 골라 주세요');
  if (provider === 'anthropic') {
    const r = (await call(`${ANTHROPIC}/messages`, {
      method: 'POST', headers: anthropicHeaders(key),
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] }),
    }, signal)) as { content?: { type: string; text?: string }[]; stop_reason?: string };
    if (r.stop_reason === 'refusal') throw new AiError('refused');
    const text = (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
    if (!text.trim()) throw new AiError('empty');
    return text;
  }
  if (provider === 'openai') {
    const r = (await call(`${OPENAI}/chat/completions`, {
      method: 'POST', headers: openaiHeaders(key),
      body: JSON.stringify({ model, max_completion_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
    }, signal)) as { choices?: { message?: { content?: string; refusal?: string } }[] };
    const m = r.choices?.[0]?.message;
    if (m?.refusal) throw new AiError('refused', m.refusal);
    if (!m?.content?.trim()) throw new AiError('empty');
    return m.content;
  }
  const r = (await call(`${GEMINI}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', headers: geminiHeaders(key),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  }, signal)) as GeminiResponse;
  return geminiText(r);
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string; inlineData?: { mimeType: string; data: string }; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}
function geminiText(r: GeminiResponse): string {
  if (r.promptFeedback?.blockReason) throw new AiError('refused', r.promptFeedback.blockReason);
  const c = r.candidates?.[0];
  if (c?.finishReason === 'SAFETY' || c?.finishReason === 'PROHIBITED_CONTENT') throw new AiError('refused');
  const text = (c?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('');
  if (!text.trim()) throw new AiError('empty');
  return text;
}

export async function generateJSON<T = unknown>(req: TextRequest & { schema: Record<string, unknown> }): Promise<T> {
  const { provider, key, model, system, prompt, schema, maxTokens = 16000, signal } = req;
  if (!key) throw new AiError('no_key');
  if (!model) throw new AiError('bad_request', '모델을 골라 주세요');
  if (provider === 'anthropic') {
    // a forced tool call returns the object already parsed
    const r = (await call(`${ANTHROPIC}/messages`, {
      method: 'POST', headers: anthropicHeaders(key),
      body: JSON.stringify({
        model, max_tokens: maxTokens, system,
        messages: [{ role: 'user', content: prompt }],
        tools: [{ name: 'submit', description: '결과를 제출합니다.', input_schema: schema }],
        tool_choice: { type: 'tool', name: 'submit' },
      }),
    }, signal)) as { content?: { type: string; input?: unknown; text?: string }[]; stop_reason?: string };
    if (r.stop_reason === 'refusal') throw new AiError('refused');
    const tool = (r.content ?? []).find((c) => c.type === 'tool_use');
    if (tool?.input && typeof tool.input === 'object') return tool.input as T;
    const text = (r.content ?? []).map((c) => c.text ?? '').join('');
    return extractJSON(text) as T;
  }
  if (provider === 'openai') {
    const r = (await call(`${OPENAI}/chat/completions`, {
      method: 'POST', headers: openaiHeaders(key),
      body: JSON.stringify({
        model, max_completion_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
        response_format: { type: 'json_schema', json_schema: { name: 'cardnovel', strict: true, schema } },
      }),
    }, signal)) as { choices?: { message?: { content?: string; refusal?: string } }[] };
    const m = r.choices?.[0]?.message;
    if (m?.refusal) throw new AiError('refused', m.refusal);
    if (!m?.content) throw new AiError('empty');
    return extractJSON(m.content) as T;
  }
  const r = (await call(`${GEMINI}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', headers: geminiHeaders(key),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt + '\n\nJSON 스키마:\n' + JSON.stringify(schema) }] }],
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: maxTokens },
    }),
  }, signal)) as GeminiResponse;
  return extractJSON(geminiText(r)) as T;
}

/* ================= images ================= */
export interface ImageResult { mime: string; b64: string }
export interface ImageRequest {
  provider: 'gemini' | 'openai';
  key: string;
  model: string;
  prompt: string;
  /** width / height of the picture area on the card */
  aspect: number;
  /** pictures to match (style and characters), e.g. the cover */
  refs?: { mime: string; b64: string }[];
  signal?: AbortSignal;
}

const GEMINI_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const OPENAI_SIZES = ['1024x1024', '1536x1024', '1024x1536'];
const ratioValue = (r: string) => { const [a, b] = r.split(/[:x]/).map(Number); return a / b; };
export const nearest = (aspect: number, options: string[]): string =>
  options.reduce((best, o) => (Math.abs(Math.log(ratioValue(o) / aspect)) < Math.abs(Math.log(ratioValue(best) / aspect)) ? o : best));

export async function generateImage(req: ImageRequest): Promise<ImageResult> {
  const { provider, key, model, prompt, aspect, refs = [], signal } = req;
  if (!key) throw new AiError('no_key');
  if (!model) throw new AiError('bad_request', '그림 모델을 골라 주세요');
  if (provider === 'openai') {
    const size = nearest(aspect, OPENAI_SIZES);
    let r: { data?: { b64_json?: string }[] };
    if (refs.length) {
      const fd = new FormData();
      fd.append('model', model);
      fd.append('prompt', prompt);
      fd.append('size', size);
      refs.forEach((ref, i) => fd.append('image[]', b64ToBlob(ref.b64, ref.mime), `ref${i}.${ref.mime.split('/')[1] || 'png'}`));
      r = (await call(`${OPENAI}/images/edits`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd }, signal)) as typeof r;
    } else {
      r = (await call(`${OPENAI}/images/generations`, {
        method: 'POST', headers: openaiHeaders(key), body: JSON.stringify({ model, prompt, size, n: 1 }),
      }, signal)) as typeof r;
    }
    const b64 = r.data?.[0]?.b64_json;
    if (!b64) throw new AiError('empty');
    return { mime: 'image/png', b64 };
  }
  const parts: unknown[] = [{ text: prompt }];
  refs.forEach((ref) => parts.push({ inline_data: { mime_type: ref.mime, data: ref.b64 } }));
  const r = (await call(`${GEMINI}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', headers: geminiHeaders(key),
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: nearest(aspect, GEMINI_RATIOS) } },
    }),
  }, signal)) as GeminiResponse;
  if (r.promptFeedback?.blockReason) throw new AiError('refused', r.promptFeedback.blockReason);
  const part = (r.candidates?.[0]?.content?.parts ?? []).find((p) => p.inlineData?.data);
  if (!part?.inlineData) {
    const reason = r.candidates?.[0]?.finishReason;
    throw new AiError(reason && /SAFETY|PROHIBITED|IMAGE_SAFETY/.test(reason) ? 'refused' : 'empty');
  }
  return { mime: part.inlineData.mimeType || 'image/png', b64: part.inlineData.data };
}

export function b64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Blob([u], { type: mime });
}
