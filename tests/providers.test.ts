import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiError, extractJSON, generateImage, generateJSON, listModels, nearest, pickDefault } from '../src/ai/providers';

afterEach(() => vi.unstubAllGlobals());

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('extractJSON', () => {
  it('reads fenced JSON', () => expect(extractJSON('```json\n{"a":1}\n```')).toEqual({ a: 1 }));
  it('reads JSON after words', () => expect(extractJSON('여기요: {"a":2} 끝')).toEqual({ a: 2 }));
  it('throws invalid_json otherwise', () => expect(() => extractJSON('없음')).toThrow(AiError));
});

describe('nearest', () => {
  it('picks the closest aspect ratio', () => {
    expect(nearest(1080 / 640, ['1:1', '3:2', '16:9'])).toBe('16:9');
    expect(nearest(1080 / 1000, ['1:1', '3:2', '16:9'])).toBe('1:1');
    expect(nearest(1080 / 640, ['1024x1024', '1536x1024', '1024x1536'])).toBe('1536x1024');
  });
});

describe('requests', () => {
  it('Claude: forced tool call with browser header, answer read from the tool input', async () => {
    const fetchMock = vi.fn(async () => reply({ content: [{ type: 'tool_use', name: 'submit', input: { text: '안녕' } }], stop_reason: 'tool_use' }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await generateJSON({ provider: 'anthropic', key: 'k', model: 'm', system: 's', prompt: 'p', schema: { type: 'object' } });
    expect(out).toEqual({ text: '안녕' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init.headers as Record<string, string>)['anthropic-dangerous-direct-browser-access']).toBe('true');
    const body = JSON.parse(String(init.body));
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'submit' });
  });
  it('OpenAI: strict json_schema response format', async () => {
    const fetchMock = vi.fn(async () => reply({ choices: [{ message: { content: '{"text":"hi"}' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await generateJSON({ provider: 'openai', key: 'k', model: 'gpt-x', system: 's', prompt: 'p', schema: { type: 'object' } });
    expect(out).toEqual({ text: 'hi' });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.response_format.json_schema.strict).toBe(true);
  });
  it('Gemini: JSON mime type, text parts joined', async () => {
    const fetchMock = vi.fn(async () => reply({ candidates: [{ content: { parts: [{ text: '{"text":' }, { text: '"ok"}' }] } }] }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await generateJSON({ provider: 'google', key: 'k', model: 'gemini-x', system: 's', prompt: 'p', schema: { type: 'object' } });
    expect(out).toEqual({ text: 'ok' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/models/gemini-x:generateContent');
    expect(JSON.parse(String(init.body)).generationConfig.responseMimeType).toBe('application/json');
  });
  it('maps a 401 to invalid_key without retrying', async () => {
    const fetchMock = vi.fn(async () => reply({ error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401));
    vi.stubGlobal('fetch', fetchMock);
    await expect(listModels('anthropic', 'bad')).rejects.toMatchObject({ code: 'invalid_key' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('Gemini image: picture comes back as inline data, aspect ratio chosen from the card', async () => {
    const fetchMock = vi.fn(async () => reply({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }] } }] }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await generateImage({ provider: 'gemini', key: 'k', model: 'gemini-img', prompt: 'p', aspect: 1080 / 640 });
    expect(r).toEqual({ mime: 'image/png', b64: 'AAAA' });
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)).generationConfig.imageConfig.aspectRatio).toBe('16:9');
  });
  it('lists Gemini text and image models separately', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ models: [
      { name: 'models/gemini-3-pro', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3-pro-image', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding-9', supportedGenerationMethods: ['embedContent'] },
    ] })));
    const r = await listModels('google', 'k');
    expect(r.text.map((m) => m.id)).toEqual(['gemini-3-pro', 'gemini-3-flash']);
    expect(r.image.map((m) => m.id)).toEqual(['gemini-3-pro-image']);
    expect(pickDefault('google', r.text)).toBe('gemini-3-flash');
  });
});
