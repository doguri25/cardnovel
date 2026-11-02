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

/* ================= usage (tokens and pictures per call) ================= */
export type UsageTag = 'compose' | 'rewrite' | 'outro' | 'summary' | 'review' | 'proof' | 'insight' | 'caption' | 'bible' | 'svg' | 'image' | 'refsheet' | 'cover' | 'tts' | 'other';
export interface UsageEvent {
  provider: TextProvider;
  model: string;
  /** what the call was for (구성, 평가, 그림 …) */
  tag: UsageTag;
  input: number;
  output: number;
  images: number;
  /** characters read aloud (AI narration), priced per 1,000 characters */
  chars?: number;
}
let usageSink: ((u: UsageEvent) => void) | null = null;
/** The app records every successful call through this (tokens, pictures), to show spending. */
export const onUsage = (fn: ((u: UsageEvent) => void) | null): void => { usageSink = fn; };
const report = (u: UsageEvent) => { try { usageSink?.(u); } catch { /* recording must never break a call */ } };
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
type AnthropicUsage = { usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } };
type OpenAIUsage = { usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number } };
type GeminiUsage = { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } };
const anthropicUse = (r: AnthropicUsage) => ({ input: n(r.usage?.input_tokens) + n(r.usage?.cache_creation_input_tokens) + n(r.usage?.cache_read_input_tokens), output: n(r.usage?.output_tokens) });
const openaiUse = (r: OpenAIUsage) => ({ input: n(r.usage?.prompt_tokens) || n(r.usage?.input_tokens), output: n(r.usage?.completion_tokens) || n(r.usage?.output_tokens) });
const geminiUse = (r: GeminiUsage) => ({ input: n(r.usageMetadata?.promptTokenCount), output: n(r.usageMetadata?.candidatesTokenCount) + n(r.usageMetadata?.thoughtsTokenCount) });

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

export interface ModelLists { text: ModelInfo[]; image: ModelInfo[]; tts: ModelInfo[] }

export async function listModels(provider: TextProvider, key: string, signal?: AbortSignal): Promise<ModelLists> {
  if (!key) throw new AiError('no_key');
  if (provider === 'anthropic') {
    const r = (await call(`${ANTHROPIC}/models?limit=100`, { headers: anthropicHeaders(key) }, signal)) as { data?: { id: string; display_name?: string }[] };
    const text = (r.data ?? []).map((m) => ({ id: m.id, label: m.display_name || m.id }));
    return { text, image: [], tts: [] };
  }
  if (provider === 'openai') {
    const r = (await call(`${OPENAI}/models`, { headers: openaiHeaders(key) }, signal)) as { data?: { id: string; created?: number }[] };
    const all = (r.data ?? []).sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
    const text = all
      .filter((m) => /^(gpt-|o\d)/.test(m.id) && !/(image|audio|realtime|tts|transcribe|search|embedding|instruct|moderation|codex|computer-use)/.test(m.id))
      .map((m) => ({ id: m.id, label: m.id }));
    const image = all.filter((m) => /^gpt-image/.test(m.id)).map((m) => ({ id: m.id, label: m.id }));
    const tts = all.filter((m) => /tts/.test(m.id) && !/realtime|audio-preview/.test(m.id)).sort((a, b) => ttsScore(b.id) - ttsScore(a.id)).map((m) => ({ id: m.id, label: m.id }));
    return { text, image, tts };
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
  const tts = gen.filter((m) => /gemini/.test(id(m)) && /tts/.test(id(m))).sort((a, b) => ttsScore(id(b)) - ttsScore(id(a))).map((m) => ({ id: id(m), label: m.displayName || id(m) }));
  return { text, image, tts };
}

/** Speech models first that read Korean well and take a style instruction: gpt-4o-mini-tts, Gemini flash TTS. */
const ttsScore = (id: string) => (/gpt-4o-mini-tts$|gpt-4o-mini-tts/.test(id) ? 50 : /flash.*tts/.test(id) ? 40 + geminiScore(id) / 100 : /pro.*tts/.test(id) ? 30 + geminiScore(id) / 100 : /tts-1-hd/.test(id) ? 20 : /tts-1/.test(id) ? 10 : 0) - (/\d{4}-\d{2}-\d{2}/.test(id) ? 1 : 0);

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
  /** what the call is for, for the usage record */
  tag?: UsageTag;
}

export async function generateText(req: TextRequest): Promise<string> {
  const { provider, key, model, system, prompt, maxTokens = 16000, signal, tag = 'other' } = req;
  if (!key) throw new AiError('no_key');
  if (!model) throw new AiError('bad_request', '모델을 골라 주세요');
  if (provider === 'anthropic') {
    const r = (await call(`${ANTHROPIC}/messages`, {
      method: 'POST', headers: anthropicHeaders(key),
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] }),
    }, signal)) as { content?: { type: string; text?: string }[]; stop_reason?: string } & AnthropicUsage;
    report({ provider, model, tag, images: 0, ...anthropicUse(r) });
    if (r.stop_reason === 'refusal') throw new AiError('refused');
    const text = (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
    if (!text.trim()) throw new AiError('empty');
    return text;
  }
  if (provider === 'openai') {
    const r = (await call(`${OPENAI}/chat/completions`, {
      method: 'POST', headers: openaiHeaders(key),
      body: JSON.stringify({ model, max_completion_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
    }, signal)) as { choices?: { message?: { content?: string; refusal?: string } }[] } & OpenAIUsage;
    report({ provider, model, tag, images: 0, ...openaiUse(r) });
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
  }, signal)) as GeminiResponse & GeminiUsage;
  report({ provider, model, tag, images: 0, ...geminiUse(r) });
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

/** How each Claude model gives JSON back, once known: structured outputs (`output_config.format`, the current way; the
 *  newest models also refuse forced tool calls) or a forced tool call (models from before structured outputs). */
const claudeJsonRoute = new Map<string, 'format' | 'tool'>();
/** for tests */
export const resetClaudeJsonRoutes = (): void => claudeJsonRoute.clear();

async function claudeJSON<T>(route: 'format' | 'tool', req: TextRequest & { schema: Record<string, unknown> }): Promise<T> {
  const { key, model, system, prompt, schema, maxTokens = 16000, signal, tag = 'other' } = req;
  const base = { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] };
  const body = route === 'format'
    ? { ...base, output_config: { format: { type: 'json_schema', schema } } }
    // a forced tool call returns the object already parsed
    : { ...base, tools: [{ name: 'submit', description: '결과를 제출합니다.', input_schema: schema }], tool_choice: { type: 'tool', name: 'submit' } };
  const r = (await call(`${ANTHROPIC}/messages`, { method: 'POST', headers: anthropicHeaders(key), body: JSON.stringify(body) }, signal)) as
    { content?: { type: string; input?: unknown; text?: string }[]; stop_reason?: string } & AnthropicUsage;
  report({ provider: 'anthropic', model, tag, images: 0, ...anthropicUse(r) });
  if (r.stop_reason === 'refusal') throw new AiError('refused');
  if (route === 'tool') {
    const tool = (r.content ?? []).find((c) => c.type === 'tool_use');
    if (tool?.input && typeof tool.input === 'object') return tool.input as T;
  }
  const text = (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
  if (!text.trim()) throw new AiError(r.stop_reason === 'max_tokens' ? 'invalid_json' : 'empty');
  return extractJSON(text) as T;
}

export async function generateJSON<T = unknown>(req: TextRequest & { schema: Record<string, unknown> }): Promise<T> {
  const { provider, key, model, system, prompt, schema, maxTokens = 16000, signal, tag = 'other' } = req;
  if (!key) throw new AiError('no_key');
  if (!model) throw new AiError('bad_request', '모델을 골라 주세요');
  if (provider === 'anthropic') {
    const route = claudeJsonRoute.get(model) ?? 'format';
    try {
      const out = await claudeJSON<T>(route, req);
      claudeJsonRoute.set(model, route);
      return out;
    } catch (e) {
      // the newest models refuse forced tool calls; some older ones do not know structured outputs: try the other way once
      const other = route === 'format' ? 'tool' : 'format';
      if (e instanceof AiError && e.code === 'bad_request' && (route === 'format' ? /output_config|output_format|json_schema|format|schema/i : /tool_choice|tool/i).test(e.message)) {
        const out = await claudeJSON<T>(other, req);
        claudeJsonRoute.set(model, other);
        return out;
      }
      throw e;
    }
  }
  if (provider === 'openai') {
    const r = (await call(`${OPENAI}/chat/completions`, {
      method: 'POST', headers: openaiHeaders(key),
      body: JSON.stringify({
        model, max_completion_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
        response_format: { type: 'json_schema', json_schema: { name: 'cardnovel', strict: true, schema } },
      }),
    }, signal)) as { choices?: { message?: { content?: string; refusal?: string } }[] } & OpenAIUsage;
    report({ provider, model, tag, images: 0, ...openaiUse(r) });
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
  }, signal)) as GeminiResponse & GeminiUsage;
  report({ provider, model, tag, images: 0, ...geminiUse(r) });
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
  tag?: UsageTag;
}

const GEMINI_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const OPENAI_SIZES = ['1024x1024', '1536x1024', '1024x1536'];
const ratioValue = (r: string) => { const [a, b] = r.split(/[:x]/).map(Number); return a / b; };
export const nearest = (aspect: number, options: string[]): string =>
  options.reduce((best, o) => (Math.abs(Math.log(ratioValue(o) / aspect)) < Math.abs(Math.log(ratioValue(best) / aspect)) ? o : best));

export async function generateImage(req: ImageRequest): Promise<ImageResult> {
  const { provider, key, model, prompt, aspect, refs = [], signal, tag = 'image' } = req;
  if (!key) throw new AiError('no_key');
  if (!model) throw new AiError('bad_request', '그림 모델을 골라 주세요');
  if (provider === 'openai') {
    const size = nearest(aspect, OPENAI_SIZES);
    let r: { data?: { b64_json?: string }[] } & OpenAIUsage;
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
    report({ provider: 'openai', model, tag, images: 1, ...openaiUse(r) });
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
  }, signal)) as GeminiResponse & GeminiUsage;
  if (r.promptFeedback?.blockReason) throw new AiError('refused', r.promptFeedback.blockReason);
  const part = (r.candidates?.[0]?.content?.parts ?? []).find((p) => p.inlineData?.data);
  if (!part?.inlineData) {
    const reason = r.candidates?.[0]?.finishReason;
    throw new AiError(reason && /SAFETY|PROHIBITED|IMAGE_SAFETY/.test(reason) ? 'refused' : 'empty');
  }
  report({ provider: 'google', model, tag, images: 1, ...geminiUse(r) });
  return { mime: part.inlineData.mimeType || 'image/png', b64: part.inlineData.data };
}

/* ================= speech (AI narration) ================= */
export interface SpeechRequest {
  provider: 'openai' | 'google';
  key: string;
  model: string;
  voice: string;
  text: string;
  /** how to read it (English works best with both providers) */
  style?: string;
  /** 1 = normal; OpenAI tts-1 takes it as is, the other models get it as part of the style */
  speed?: number;
  signal?: AbortSignal;
}
/** Encoded audio (OpenAI: MP3) to decode, or raw 16-bit PCM (Gemini) with its sample rate. */
export type SpeechAudio = { kind: 'encoded'; data: ArrayBuffer; mime: string } | { kind: 'pcm'; data: ArrayBuffer; rate: number };

export const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
/** voices the older tts-1 models know */
export const OPENAI_TTS1_VOICES = ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'];
export const GEMINI_VOICES = ['Kore', 'Aoede', 'Leda', 'Sulafat', 'Achernar', 'Vindemiatrix', 'Despina', 'Zephyr', 'Charon', 'Puck', 'Orus', 'Fenrir', 'Algenib', 'Gacrux', 'Enceladus', 'Iapetus', 'Schedar', 'Achird'];

const paceWords = (speed = 1) => (speed >= 1.25 ? ' Read at a brisk, quick pace.' : speed > 1.05 ? ' Read at a slightly quick pace.' : '');

/** fetch for a binary answer (audio); errors still come back as JSON and are classified like the others */
async function callBinary(url: string, init: RequestInit, signal?: AbortSignal, retries = 2): Promise<ArrayBuffer> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal });
    } catch (e) {
      if (signal?.aborted) throw new AiError('cancelled');
      if (attempt < retries) { await sleep(1500 * (attempt + 1), signal); continue; }
      throw new AiError('network', String(e));
    }
    if (res.ok) return res.arrayBuffer();
    const text = await res.text();
    let body: unknown;
    try { body = text ? JSON.parse(text) : null; } catch { body = { error: { message: text.slice(0, 300) } }; }
    const err = classify(res.status, body);
    if (['rate_limited', 'overloaded', 'upstream'].includes(err.code) && !/insufficient_quota/i.test(err.message) && attempt < retries) {
      const ra = Number(res.headers.get('retry-after'));
      await sleep(ra > 0 && ra < 30 ? ra * 1000 : 2000 * (attempt + 1) ** 2, signal);
      continue;
    }
    throw err;
  }
}

/** One stretch of text read aloud. */
export async function generateSpeech(req: SpeechRequest): Promise<SpeechAudio> {
  const { provider, key, model, voice, text, style = '', speed = 1, signal } = req;
  if (!key) throw new AiError('no_key');
  if (!model) throw new AiError('bad_request', '낭독 모델을 골라 주세요');
  if (!text.trim()) throw new AiError('empty');
  if (provider === 'openai') {
    const old = /^tts-1/.test(model);
    const body: Record<string, unknown> = { model, input: text, voice: old && !OPENAI_TTS1_VOICES.includes(voice) ? 'alloy' : voice, response_format: 'mp3' };
    if (old) { if (speed !== 1) body.speed = speed; } else if (style || speed !== 1) body.instructions = (style + paceWords(speed)).trim();
    const data = await callBinary(`${OPENAI}/audio/speech`, { method: 'POST', headers: openaiHeaders(key), body: JSON.stringify(body) }, signal);
    if (!data.byteLength) throw new AiError('empty');
    report({ provider: 'openai', model, tag: 'tts', input: 0, output: 0, images: 0, chars: text.length });
    return { kind: 'encoded', data, mime: 'audio/mpeg' };
  }
  const say = `${(style + paceWords(speed)).trim() || 'Read the following Korean text aloud naturally.'}\n\n${text}`;
  const r = (await call(`${GEMINI}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', headers: geminiHeaders(key),
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: say }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
    }),
  }, signal)) as GeminiResponse & GeminiUsage;
  if (r.promptFeedback?.blockReason) throw new AiError('refused', r.promptFeedback.blockReason);
  const part = (r.candidates?.[0]?.content?.parts ?? []).find((p) => p.inlineData?.data);
  if (!part?.inlineData) throw new AiError(/SAFETY|PROHIBITED/.test(r.candidates?.[0]?.finishReason ?? '') ? 'refused' : 'empty');
  report({ provider: 'google', model, tag: 'tts', input: 0, output: 0, images: 0, chars: text.length });
  const mime = part.inlineData.mimeType || '';
  const bytes = b64ToBytes(part.inlineData.data);
  if (/wav|mpeg|mp3|ogg/.test(mime)) return { kind: 'encoded', data: bytes.buffer as ArrayBuffer, mime };
  const rate = Number((mime.match(/rate=(\d+)/) || [])[1]) || 24000;
  return { kind: 'pcm', data: bytes.buffer as ArrayBuffer, rate };
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

export function b64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Blob([u], { type: mime });
}
