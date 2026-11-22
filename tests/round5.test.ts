import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyProof, keepMarks, normalizeProof, proofPrompt, proofSpots, PROOF_SCHEMA, spotValue } from '../src/ai/proof';
import { generateSpeech, listModels, onUsage, type UsageEvent } from '../src/ai/providers';
import { reviewPrompt } from '../src/ai/review';
import { changeCount, diffWords, tokenize } from '../src/diff';
import { DEFAULTS, newPost, newWork, type Work } from '../src/model';
import { estimateSeconds, narrationScript, scriptChars, voicesFor } from '../src/narration';
import { bestPerWork, collectRows, groupBy, normalizeInsight, postsCSV, reviewHistory, rowOf, usesRate, WEEKDAY } from '../src/posts';
import { cardDurations, DUCK, musicLevels, startsOf, totalDuration, VOICE_LEAD, VOICE_TAIL } from '../src/reels';
import { estimateCost } from '../src/usage';
import { DEFAULT_SETTINGS } from '../src/settings';

afterEach(() => { vi.unstubAllGlobals(); onUsage(null); });

const sample = (): Work => {
  const w = newWork(DEFAULTS);
  w.cards[0].title = '막차';
  w.cards[0].text = '마지막 버스엔 *아무도* 없었다';
  w.cards[1].text = '나는 그날 집에 갈수 없었다.\n버스는 오지 않았다.';
  w.cards[2].text = '기사가 *문을* 열었다';
  w.cards[3].title = '두 번째 밤';
  w.cards[3].text = '그는 웃었다.';
  w.cards[19].text = '당신이라면 탔을까요?';
  w.caption = '오늘 밤 이야기';
  return w;
};

describe('word diff', () => {
  it('splits words and spaces', () => expect(tokenize('a  b')).toEqual(['a', '  ', 'b']));
  it('shows a spacing fix as one replaced stretch', () => {
    const d = diffWords('할수 있다', '할 수 있다');
    expect(d).toEqual([{ op: 'del', text: '할수' }, { op: 'ins', text: '할 수' }, { op: 'eq', text: ' 있다' }]);
    expect(changeCount(d)).toBe(1);
  });
  it('keeps unchanged text whole and counts separate changes', () => {
    expect(diffWords('그대로 둔다', '그대로 둔다')).toEqual([{ op: 'eq', text: '그대로 둔다' }]);
    const d = diffWords('안되 나는 갈께', '안 돼 나는 갈게');
    expect(changeCount(d)).toBe(2);
    expect(d.filter((p) => p.op !== 'del').map((p) => p.text).join('')).toBe('안 돼 나는 갈게');
    expect(d.filter((p) => p.op !== 'ins').map((p) => p.text).join('')).toBe('안되 나는 갈께');
  });
});

describe('batch proofreading', () => {
  it('lists every place with words, with keys the AI answers by', () => {
    const w = sample();
    const spots = proofSpots(w);
    expect(spots.map((s) => s.key)).toEqual(['1t', '1', '2', '3', '4t', '4', '20', 'cap']);
    expect(spots.find((s) => s.key === '4t')?.label).toBe('04 소제목');
    w.outroKind = 'none';
    expect(proofSpots(w).some((s) => s.key === '20')).toBe(false);
    expect(spotValue(w, { index: -1, field: 'caption' })).toBe('오늘 밤 이야기');
  });
  it('asks for fixes only, with the tone rule and the line ids', () => {
    const w = sample();
    const p = proofPrompt(proofSpots(w), 'haeyo');
    expect(p).toContain('[2] (02) 나는 그날 집에 갈수 없었다.\\n버스는 오지 않았다.');
    expect(p).toContain('해요체');
    expect(proofPrompt(proofSpots(w), 'keep')).toContain('바꾸지 않습니다');
    expect((PROOF_SCHEMA.properties.fixes.items.properties.changes.items.properties.kind as { enum: string[] }).enum).toContain('spacing');
  });
  it('puts back emphasis marks the AI dropped', () => {
    expect(keepMarks('마지막 *버스* 안', '마지막 버스 안에')).toEqual({ text: '마지막 *버스* 안에', lost: false });
    expect(keepMarks('*할수* 없다', '할 수 없다')).toEqual({ text: '할 수 없다', lost: true });
    expect(keepMarks('표시 없음', '표시없음')).toEqual({ text: '표시없음', lost: false });
  });
  it('keeps real fixes, drops unknown ids, no-ops and rewrites', () => {
    const w = sample();
    const spots = proofSpots(w);
    const r = normalizeProof({
      fixes: [
        { id: '2', corrected: '나는 그날 집에 갈 수 없었다.\\n버스는 오지 않았다.', changes: [{ kind: 'spacing', from: '갈수', to: '갈 수' }] },
        { id: '[3]', corrected: '기사가 문을 열었다.', changes: [{ kind: 'punct', from: '열었다', to: '열었다.' }, { kind: 'weird', from: 'a', to: 'b' }] },
        { id: '4', corrected: '그는 웃었다.', changes: [] },
        { id: '1', corrected: '마지막 버스엔 아무도 없었고 운전석에는 낯선 남자가 앉아 고개를 숙인 채 졸고 있었다', changes: [] },
        { id: '99', corrected: '없는 카드', changes: [] },
        { id: '2', corrected: '중복', changes: [] },
      ],
      summary: '띄어쓰기 1곳, 문장부호 1곳',
    }, w, spots, 'keep', 1);
    expect(r.items.map((i) => i.key)).toEqual(['2', '3']);
    expect(r.items[0].to).toBe('나는 그날 집에 갈 수 없었다.\n버스는 오지 않았다.');
    expect(r.items[1].to).toBe('기사가 *문을* 열었다.'); // emphasis put back
    expect(r.items[1].changes.map((c) => c.kind)).toEqual(['punct', 'spelling']);
    expect(r.checked).toBe(spots.length);
    expect(r.summary).toContain('띄어쓰기');
  });
  it('applies a fix only while the card still says what was checked', () => {
    const w = sample();
    const r = normalizeProof({ fixes: [{ id: 'cap', corrected: '오늘 밤의 이야기', changes: [] }, { id: '4', corrected: '그는 웃었다!', changes: [] }] }, w, proofSpots(w), 'keep');
    expect(applyProof(w, r.items[0])).toBe(true);
    expect(w.cards[3].text).toBe('그는 웃었다!');
    w.caption = '바뀐 캡션';
    expect(applyProof(w, r.items[1])).toBe(false);
    expect(w.caption).toBe('바뀐 캡션');
  });
});

describe('AI narration', () => {
  it('reads titles and texts without emphasis marks or line breaks, ending each with a stop', () => {
    const w = sample();
    const s = narrationScript(w);
    expect(s[0]).toBe('막차. 마지막 버스엔 아무도 없었다.');
    expect(s[1]).toBe('나는 그날 집에 갈수 없었다. 버스는 오지 않았다.');
    expect(s[3]).toBe('두 번째 밤. 그는 웃었다.');
    expect(s[5]).toBe('');
    expect(s[19]).toBe('당신이라면 탔을까요?');
    expect(narrationScript(w, true)[19]).toBe(`당신이라면 탔을까요? ${DEFAULTS.follow}.`);
    w.outroKind = 'none';
    expect(narrationScript(w)[19]).toBe('');
    expect(scriptChars(['ab', '', 'c'])).toBe(3);
  });
  it('estimates reading time and offers the voices the model knows', () => {
    expect(estimateSeconds('')).toBe(0);
    expect(estimateSeconds('가'.repeat(60))).toBeCloseTo(10.3);
    expect(estimateSeconds('가'.repeat(60), 1.3)).toBeLessThan(8);
    expect(voicesFor('openai', 'tts-1')).not.toContain('ballad');
    expect(voicesFor('openai', 'gpt-4o-mini-tts')).toContain('ballad');
    expect(voicesFor('google', 'x')).toContain('Kore');
  });
  it('keeps each card on screen until its narration is over', () => {
    const w = sample();
    const voice = w.cards.map((_, i) => (i === 1 ? 7 : i === 19 ? 3 : null));
    const d = cardDurations(w, 'auto', voice);
    expect(d[1]).toBeCloseTo(7 + VOICE_LEAD + VOICE_TAIL + 0.45);
    expect(d[19]).toBeCloseTo(3 + VOICE_LEAD + VOICE_TAIL); // no transition after the last card
    expect(d[5]).toBe(cardDurations(w, 'auto')[5]); // silent card: as before
    expect(cardDurations(w, 10, voice)[1]).toBe(10); // a fixed time longer than the reading stays
    expect(startsOf([1, 2, 3])).toEqual([0, 1, 3]);
    expect(totalDuration(d)).toBeGreaterThan(totalDuration(cardDurations(w, 'auto')) - 60);
  });
  it('lowers the music under the narration and fades it out', () => {
    const pts = musicLevels(30, 0.8, [[5, 9], [9.5, 12], [20, 22]]);
    for (let i = 1; i < pts.length; i++) expect(pts[i][0]).toBeGreaterThanOrEqual(pts[i - 1][0]);
    const at = (t: number) => { // level at time t on the ramps
      for (let i = 1; i < pts.length; i++) if (t <= pts[i][0]) { const [t0, a] = pts[i - 1], [t1, b] = pts[i]; return t1 === t0 ? b : a + ((b - a) * (t - t0)) / (t1 - t0); }
      return pts[pts.length - 1][1];
    };
    expect(at(3)).toBeCloseTo(0.8);
    expect(at(7)).toBeCloseTo(0.8 * DUCK);
    expect(at(9.25)).toBeCloseTo(0.8 * DUCK); // short gap between two stretches stays low
    expect(at(16)).toBeCloseTo(0.8);
    expect(at(21)).toBeCloseTo(0.8 * DUCK);
    expect(pts[pts.length - 1]).toEqual([30, 0]);
    const early = musicLevels(10, 0.5, [[0.3, 4]]);
    expect(early[1][1]).toBeCloseTo(0.5 * DUCK); // narration from the start: fade in to the low level
  });
  it('OpenAI speech: style as instructions for gpt-4o models, speed and a known voice for tts-1, characters recorded', async () => {
    const seen: UsageEvent[] = [];
    onUsage((u) => seen.push(u));
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } }));
    vi.stubGlobal('fetch', fetchMock);
    const a = await generateSpeech({ provider: 'openai', key: 'k', model: 'gpt-4o-mini-tts', voice: 'ballad', text: '안녕하세요', style: 'Calm.', speed: 1.3 });
    expect(a.kind).toBe('encoded');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/audio/speech');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: 'gpt-4o-mini-tts', voice: 'ballad', input: '안녕하세요', response_format: 'mp3' });
    expect(body.instructions).toContain('Calm.');
    expect(body.instructions).toContain('brisk');
    expect(body.speed).toBeUndefined();
    await generateSpeech({ provider: 'openai', key: 'k', model: 'tts-1', voice: 'ballad', text: '둘', style: 'Calm.', speed: 1.15 });
    const old = JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body));
    expect(old).toMatchObject({ voice: 'alloy', speed: 1.15 });
    expect(old.instructions).toBeUndefined();
    expect(seen.map((u) => [u.tag, u.chars])).toEqual([['tts', 5], ['tts', 1]]);
  });
  it('Gemini speech: audio modality with the voice, PCM read with its sample rate', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: btoa('\x01\x00\x02\x00') } }] } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const a = await generateSpeech({ provider: 'google', key: 'g', model: 'gemini-2.5-flash-preview-tts', voice: 'Kore', text: '안녕', style: 'Read calmly.' });
    expect(a).toMatchObject({ kind: 'pcm', rate: 24000 });
    expect(a.data.byteLength).toBe(4);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/models/gemini-2.5-flash-preview-tts:generateContent');
    const body = JSON.parse(String(init.body));
    expect(body.generationConfig.responseModalities).toEqual(['AUDIO']);
    expect(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Kore');
    expect(body.contents[0].parts[0].text).toBe('Read calmly.\n\n안녕');
  });
  it('a failed speech request is classified like the others', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 })));
    await expect(generateSpeech({ provider: 'openai', key: 'k', model: 'tts-1', voice: 'nova', text: '가' })).rejects.toMatchObject({ code: 'invalid_key' });
  });
  it('lists speech models, the ones that take a style first', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'tts-1', created: 3 }, { id: 'gpt-4o-mini-tts', created: 2 }, { id: 'tts-1-hd', created: 1 }, { id: 'gpt-4o-realtime-preview', created: 4 }, { id: 'gpt-5', created: 5 }] }), { status: 200 })));
    const l = await listModels('openai', 'k');
    expect(l.tts.map((m) => m.id)).toEqual(['gpt-4o-mini-tts', 'tts-1-hd', 'tts-1']);
    expect(l.text.map((m) => m.id)).toEqual(['gpt-5']);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ models: [
      { name: 'models/gemini-2.5-pro-preview-tts', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
    ] }), { status: 200 })));
    const g = await listModels('google', 'k');
    expect(g.tts.map((m) => m.id)).toEqual(['gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts']);
    expect(g.text.map((m) => m.id)).toEqual(['gemini-2.5-flash']);
  });
  it('prices narration per 1,000 characters', () => {
    const ev: UsageEvent = { provider: 'openai', model: 'tts-1', tag: 'tts', input: 0, output: 0, images: 0, chars: 2000 };
    expect(estimateCost(ev, DEFAULT_SETTINGS)).toBeCloseTo(2 * DEFAULT_SETTINGS.ttsPrices.openai);
    expect(estimateCost({ ...ev, provider: 'google' }, { prices: DEFAULT_SETTINGS.prices, textPrices: DEFAULT_SETTINGS.textPrices })).toBeCloseTo(2 * DEFAULT_SETTINGS.ttsPrices.google);
  });
});

describe('posting log and performance', () => {
  const posted = (title: string, hook: string, at: number, n: Partial<Record<'reach' | 'likes' | 'comments' | 'saves' | 'shares' | 'follows', number>>, theme: Work['theme'] = 'fog') => {
    const w = newWork(DEFAULTS);
    w.cards[0].title = title; w.cards[0].text = hook; w.theme = theme;
    w.posts = [{ ...newPost(at), ...n }];
    return w;
  };
  const tue9 = new Date(2026, 9, 6, 21, 0).getTime(); // a Tuesday, 9 pm
  const sat10 = new Date(2026, 9, 10, 10, 0).getTime();
  const all = [
    posted('막차', '마지막 버스엔 아무도 없었다', tue9, { reach: 1000, likes: 80, comments: 10, saves: 30, shares: 10 }),
    posted('빈집', '불이 켜져 있었다', sat10, { reach: 2000, likes: 50, comments: 5, saves: 5, shares: 0 }, 'ink'),
    posted('편지', '보낸 사람이 없다', tue9 + 7 * 86400000, { reach: 500, likes: 40, comments: 5, saves: 20, shares: 5 }),
  ];
  all[2].episode = 2;
  const empty = newWork(DEFAULTS);
  empty.posts = [newPost(sat10)]; // no numbers yet

  it('turns each post into a row with rate and weighted score', () => {
    const r = rowOf(all[0], all[0].posts![0]);
    expect(r.interactions).toBe(130);
    expect(r.rate).toBeCloseTo(0.13);
    expect(r.score).toBe(80 + 20 + 90 + 30);
    expect(r.weekday).toBe(2);
    expect(WEEKDAY[r.weekday]).toBe('화');
    expect(r.theme).toBe('안개');
  });
  it('ignores posts without numbers and ranks by rate when reach is there', () => {
    const rows = collectRows([...all, empty]);
    expect(rows).toHaveLength(3);
    expect(rows[0].title).toBe('편지'); // newest first
    expect(usesRate(rows)).toBe(true);
    expect(bestPerWork(rows, true).map((r) => r.title)).toEqual(['편지', '막차', '빈집']);
    const days = groupBy(rows, (r) => WEEKDAY[r.weekday], true);
    expect(days[0]).toMatchObject({ key: '화', n: 2 });
    expect(days[0].value).toBeCloseTo((0.13 + 0.14) / 2);
    const ordered = groupBy(rows, (r) => WEEKDAY[r.weekday], true, WEEKDAY);
    expect(ordered.map((g) => g.key)).toEqual(['화', '토']);
  });
  it('compares by weighted reactions when reach is mostly missing', () => {
    const w = posted('A', '', tue9, { likes: 10, saves: 15 });
    const v = posted('B', '', tue9, { likes: 50 });
    const rows = collectRows([w, v]);
    expect(usesRate(rows)).toBe(false);
    expect(bestPerWork(rows, false).map((r) => r.title)).toEqual(['A', 'B']); // saves count triple
  });
  it('tells the AI review which covers did best, never about the work being reviewed', () => {
    const h = reviewHistory(all, all[2].id);
    expect(h).toContain('(2편)');
    expect(h).toContain('"막차"');
    expect(h).not.toContain('"편지"');
    expect(reviewHistory([all[0]], 'x')).toBe('');
    const w = all[2];
    for (let i = 1; i <= 8; i++) w.cards[i].text = `본문 ${i}`;
    expect(reviewPrompt(w, h)).toContain('[참고: 이 작가의 지난 게시물 반응');
    expect(reviewPrompt(w)).not.toContain('[참고');
  });
  it('exports a spreadsheet and cleans the AI reading', () => {
    const csv = postsCSV(collectRows(all));
    expect(csv.split('\n')).toHaveLength(4);
    expect(csv).toContain('"편지","2"');
    const ins = normalizeInsight({ patterns: ['a', 3, ' b '], tips: 'x', next: ' 제목 / 훅 ' }, 3, 5);
    expect(ins).toEqual({ at: 5, posts: 3, patterns: ['a', 'b'], tips: [], next: '제목 / 훅' });
  });
});
