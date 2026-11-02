// Prompts and the JSON shape the text AI answers in.
import { BODY_COUNT, OUTRO_KINDS, stripMarks, type ArtStyle, type InputMode, type OutroKind, type Work } from '../model';
import { SVG_EXAMPLE } from './svg-example';
import { layoutOf } from '../render';

const str = { type: 'string' } as const;

/** One schema for all three providers (strict-mode compatible: every key required, no extras). */
export const COMPOSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'hook', 'cards', 'outro', 'caption', 'hashtags', 'style', 'coverScene', 'summary'],
  properties: {
    title: str,
    hook: str,
    cards: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'title', 'text', 'scene', 'accent'],
        properties: { label: str, title: str, text: str, scene: str, accent: { type: 'boolean' } },
      },
    },
    outro: str,
    caption: str,
    hashtags: { type: 'array', items: str },
    style: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'description', 'prompt', 'characters'],
      properties: { name: str, description: str, prompt: str, characters: str },
    },
    coverScene: str,
    summary: str,
  },
};

export const ONE_TEXT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['text'], properties: { text: str },
};

export const SYSTEM_WRITER = '당신은 인스타그램 카드소설을 만드는 한국어 작가이자 편집자입니다. 요청한 형식만 지키고, 설명 없이 결과만 냅니다.';

const MODE_RULES: Record<Exclude<InputMode, 'auto'>, string> = {
  long: `입력은 완성된 원고입니다. 본문 ${BODY_COUNT}장 분량으로 압축·각색합니다.
- 작가의 문체·시점·시제·인물 이름을 지킵니다. 눈에 띄는 문장은 원문 그대로 살립니다.
- 줄거리의 뼈대와 결말은 바꾸지 않고, 곁가지는 덜어냅니다.`,
  idea: `입력은 짧은 줄거리나 아이디어입니다. 살을 붙여 본문 ${BODY_COUNT}장 이야기로 완성합니다.
- 입력에 없는 설정을 더해도 되지만 입력과 모순되면 안 됩니다.
- 인물 이름은 입력을 따르고, 없으면 이야기 배경에 맞게 짓습니다.`,
  split: `입력은 작가가 이미 카드별로 나눈 원고입니다. 본문 ${BODY_COUNT}장의 text는 아래 [확정된 본문] 그대로 돌려줍니다(한 글자도 바꾸지 않음).
- 나머지 항목(제목·훅이 비어 있으면 제안, label, scene, accent, 덧붙임, 캡션, 해시태그, 그림체)만 채웁니다.`,
};

/** An earlier episode of the same series, given to the writer so the next one continues it. */
export interface PrevEpisode { episode: number; title: string; summary: string }

export function seriesBlock(series: string, episode: number | undefined, previous: PrevEpisode[] | undefined, bible = ''): string {
  const prev = episode && previous?.length ? `
연재: 「${series || '시리즈'}」 ${episode}화입니다. 아래 앞 회 줄거리를 이어받습니다.
- 인물 이름·성격·관계, 배경, 이미 밝혀진 사실을 그대로 지킵니다. 앞 회 내용을 되풀이하지 않습니다.
- 앞 회를 안 본 독자도 따라올 수 있게 첫 1~2장에서 필요한 것만 짧게 상기시킵니다.
[앞 회 줄거리]
${previous.map((p) => `${p.episode}화 「${p.title}」: ${p.summary}`).join('\n')}
` : '';
  const bib = bible.trim() ? `
[시리즈 설정집 — 여기 적힌 인물·설정은 바꾸지 않습니다. 풀리지 않은 떡밥은 이번 회에서 이어 가도 되고, 이미 풀린 떡밥은 되풀이하지 않습니다]
${bible.trim()}
` : '';
  return prev + bib;
}

export function composePrompt(opts: { mode: Exclude<InputMode, 'auto'>; story: string; outroKind: OutroKind; fixed?: { title: string; hook: string; body: { label: string; text: string }[] }; series?: string; episode?: number; previous?: PrevEpisode[]; bible?: string }): string {
  const { mode, story, outroKind, fixed } = opts;
  const outro = outroKind === 'none' ? '빈 문자열("")' : `${OUTRO_KINDS[outroKind].ask} (60자 이내)`;
  const fixedBlock = fixed
    ? `\n[확정된 본문]\n제목: ${fixed.title || '(비어 있음)'}\n훅: ${fixed.hook || '(비어 있음)'}\n${fixed.body.map((b, i) => `${i + 1}. ${b.text || '(비어 있음 — 앞뒤 흐름에 맞게 새로 씀)'}`).join('\n')}\n`
    : '';
  return `아래 입력으로 카드 20장짜리 카드소설을 만듭니다.

구성(고정):
- 표지 1장: title(2~14자)과 hook(한 줄, 25자 이내).
- 본문 정확히 ${BODY_COUNT}장(cards 배열 길이 ${BODY_COUNT}): 이야기 순서대로. 먼저 장르·분위기·핵심 사건을 파악하고, 대략 도입 2~3장 · 전개 7~9장 · 위기와 절정 4~5장 · 결말 2~3장으로 나눕니다(이야기에 맞게 조정).
- 마지막 장 덧붙임 outro: ${outro}.

${MODE_RULES[mode]}

본문 카드 규칙:
- text: 한국어 40~90자(공백 제외). 짧은 문장 2~3개. 줄바꿈은 \\n 최대 1번.
- 카드 한 장에 새 정보 하나. 넘길 때마다 다음이 궁금하게 끝냅니다.
- label: 그 카드의 흐름을 2~6자로(예: 시작, 첫 만남, 어긋남, 전환, 절정, 그 후).
- title: 대부분 빈 문자열. 꼭 필요한 카드에만 짧은 소제목.
- accent: 이야기가 뒤집히거나 감정이 가장 높은 카드 1~2장만 true.
- scene: 그 카드 글의 순간을 그림 한 장으로 옮긴 영어 한두 문장. 인물은 characters의 이름으로 부르고, 누가·어디서·언제·무엇을 하는지·핵심 사물·거리(close-up, medium shot, wide shot)를 눈에 보이는 것만 씁니다. 생각·감정·회상은 표정·몸짓·빛·사물로 바꿔 씁니다. 글자·말풍선은 넣지 않습니다.

공통: 감탄사·이모지 없이, 잔혹하거나 선정적인 묘사 없이 씁니다.

그 밖의 항목:
- style: 이 이야기에 어울리는 그림체 제안. name(한국어 2~10자), description(한국어 한 줄), prompt(영어 2~3문장: 화풍·색·빛·질감), characters(영어, 주요 인물마다 '이름: 나이·외모·옷차림' 한 문장; 인물이 없으면 빈 문자열).
- coverScene: 표지 그림 장면(영어 한두 문장, 이야기의 무대와 핵심 사물).
- caption: 인스타그램 게시글 본문 2~3문장(한국어, 결말을 밝히지 않음).
- hashtags: 6~8개, #을 붙인 한국어.
- summary: 이 회의 줄거리를 결말까지 3~4문장(한국어). 다음 회를 쓸 때 앞 회 줄거리로 씁니다. 주요 인물 이름을 넣습니다.
${seriesBlock(opts.series ?? '', opts.episode, opts.previous, opts.bible)}${fixedBlock}
[입력]
${story}`;
}

const cardsAsText = (w: Work) => w.cards
  .map((c, i) => (c.kind === 'cover' ? `표지 — 제목: ${c.title} / 훅: ${c.text}` : c.kind === 'outro' ? null : `${i + 1}. ${c.text}`))
  .filter(Boolean).join('\n');

export function rewritePrompt(w: Work, index: number, ask: string): string {
  const c = w.cards[index];
  const prev = w.cards[index - 1], next = w.cards[index + 1];
  if (c.kind === 'cover') {
    return `카드소설의 표지 훅 한 줄(25자 이내)을 새로 씁니다. 제목은 「${c.title}」입니다.
${ask ? `요청: ${ask}\n` : ''}
[이야기]
${cardsAsText(w)}

JSON으로 {"text": "훅"}만 돌려주세요.`;
  }
  return `카드소설의 ${index + 1}번 카드(본문)를 다시 씁니다. 앞뒤 카드와 이어지게, 한국어 40~90자(공백 제외), 짧은 문장 2~3개.
${ask ? `요청: ${ask}\n` : ''}
앞 카드: ${prev && prev.kind !== 'cover' ? prev.text : '(표지 다음 첫 카드)'}
지금 카드: ${c.text || '(비어 있음)'}
다음 카드: ${next && next.kind !== 'outro' ? next.text : '(마지막 본문 카드)'}

[이야기 전체]
${cardsAsText(w)}

JSON으로 {"text": "새 본문"}만 돌려주세요.`;
}

export function summaryPrompt(w: Work): string {
  return `카드소설의 줄거리를 결말까지 3~4문장으로 요약합니다(한국어). 주요 인물 이름과 밝혀진 사실을 넣습니다. 다음 회를 쓸 때 앞 회 줄거리로 씁니다.

[이야기]
${cardsAsText(w)}

JSON으로 {"text": "요약"}만 돌려주세요.`;
}

export function outroPrompt(w: Work, kind: OutroKind): string {
  return `카드소설 마지막 장에 넣을 ${OUTRO_KINDS[kind].name} 한 줄을 씁니다: ${OUTRO_KINDS[kind].ask}. 60자 이내, 이모지 없이.

[이야기]
${cardsAsText(w)}

JSON으로 {"text": "한 줄"}만 돌려주세요.`;
}

/* ================= pictures ================= */
const COMPOSITION = {
  stack: 'Composition: wide horizontal frame, main subject from the center to the right, keep the bottom quarter darker and simple because text continues below the picture.',
  full: 'Composition: full-bleed frame filling the whole card, main subject in the upper two thirds, keep the bottom third darker, calm and low in detail because text is laid over it.',
  quote: 'Composition: an atmospheric, low-detail backdrop with soft focus and no strong focal point; it will sit faintly behind a large line of dialogue.',
} as const;

export function imagePrompt(w: Work, index: number, refs: { chars?: boolean; cover?: boolean } = {}): string {
  const c = w.cards[index];
  const s = w.style;
  const scene = c.kind === 'cover'
    ? `Cover illustration for the story "${stripMarks(c.title)}". ${c.scene || stripMarks(c.text)}`
    : c.scene || `A scene for this part of a Korean short story: ${stripMarks(c.text)}`;
  const refLine = refs.chars && refs.cover
    ? 'Reference images: the first is the character sheet (keep every character\'s face, hair, build and clothes identical to it); the second is the cover (match its art style, palette and lighting).'
    : refs.chars
      ? 'Reference image: the character sheet. Keep every character\'s face, hair, build and clothes identical to it, and use its art style.'
      : refs.cover
        ? 'Match the art style, palette and character designs of the reference image exactly.'
        : '';
  return [
    s.prompt,
    s.characters ? `Characters (keep them identical on every card): ${s.characters}` : '',
    `Scene: ${scene}`,
    refLine,
    COMPOSITION[layoutOf(c)],
    'No text, letters, numbers, captions, speech bubbles, logos or watermarks anywhere in the image.',
  ].filter(Boolean).join('\n');
}

/* ---------- Canva AI: its image models weigh the start of a prompt most, so the scene goes first ---------- */
const NAME = "[A-Z][A-Za-z'’-]+(?: [A-Z][A-Za-z'’-]+){0,2}";
/** Character notes as [name, look] pairs (from "Name: …", "Name — …", "Name, a …"), and notes that name no one. */
export function parseCharacters(text: string): { named: { name: string; desc: string }[]; general: string } {
  const t = (text || '').trim();
  const re = new RegExp(`(?:^|(?<=[.;!?\\n])\\s*)(${NAME})(?:\\s*\\([^)]*\\))?\\s*(?::|\\s[—–-]\\s|,(?=\\s+(?:an?|the)\\s))\\s*`, 'g');
  const hits = [...t.matchAll(re)];
  if (!hits.length) return { named: [], general: t };
  const named = hits.map((m, i) => {
    const from = m.index! + m[0].length;
    const to = i + 1 < hits.length ? hits[i + 1].index! : t.length;
    return { name: m[1], desc: t.slice(from, to).trim().replace(/[.;\s]+$/, '') };
  }).filter((c) => c.desc);
  return { named, general: t.slice(0, hits[0].index).trim() };
}

const CANVA_FRAME = {
  stack: 'Wide shot, main subject slightly right of center, plain darker lower edge.',
  full: 'Tall full-frame shot, main subject in the upper part, calm darker lower third.',
  quote: 'Soft-focus atmospheric backdrop with no clear subject.',
} as const;
const sentence = (x: string) => (/[.!?]$/.test(x) ? x : `${x}.`);

/** The prompt for Canva AI: the scene first, then only the people in it, the framing, the art style; no title text. */
export function canvaPrompt(w: Work, index: number, variant?: string): string {
  const c = w.cards[index];
  const scene = c.scene.trim() || `A moment from a Korean short story: ${stripMarks(c.text)}`;
  const { named, general } = parseCharacters(w.style.characters);
  const has = (name: string) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(scene);
  // people named in the scene; a story with one person keeps them even when the scene says "the driver"
  const who = named.filter((p) => has(p.name) || has(p.name.split(' ')[0]));
  const people = who.length ? who : named.length === 1 ? named : [];
  return [
    sentence(scene),
    ...people.map((p) => sentence(`${p.name}: ${p.desc}`)),
    general,
    CANVA_FRAME[layoutOf(c)],
    variant ?? '',
    w.style.prompt.trim() ? `Style: ${w.style.prompt.trim()}` : '',
    'Illustration only, no lettering.',
  ].filter(Boolean).join('\n');
}

/** A turnaround-style sheet of the main characters in the work's art style. */
export function characterSheetPrompt(w: Work): string {
  const s = w.style;
  return [
    s.prompt,
    `Character reference sheet for an illustrated Korean short story${w.cards[0]?.title ? ` titled "${w.cards[0].title}"` : ''}.`,
    s.characters ? `Characters: ${s.characters}` : 'Characters: the main characters of the story, each with a clear, distinctive look.',
    'Show each main character standing side by side, full body, front view, neutral pose and expression, evenly lit, on a plain light background. Same scale for everyone, generous space between them.',
    'No text, names, labels, letters, numbers, logos or watermarks.',
  ].join('\n');
}

const NIGHT_GUIDE = `화풍 가이드:
- 어두운 밤의 미스터리 무드. 기본 팔레트는 남색·먹색 배경(#070b16 ~ #1b2233), 따뜻한 빛(#ffd58a, #ffb554)은 창문·전등·간판 한두 곳에만, 차가운 하이라이트(#9fb4d6, #cfe0ff).
- 실루엣과 역광, 안개(feGaussianBlur를 건 반투명 도형), 빗줄기(pattern), 유리의 물방울, 바닥 반사, 가장자리 비네트.
- 사람은 실루엣이나 뒷모습으로만. 얼굴 세부 없음.`;

function svgGuide(s: ArtStyle): string {
  if (s.preset === 'night') return NIGHT_GUIDE;
  return `화풍 가이드:
- 그림체: ${s.name} — ${s.description}
- 방향(영어 원문): ${s.prompt}
${s.characters ? `- 인물(모든 카드에서 같게): ${s.characters}\n` : ''}- 사람은 단순한 형태로, 얼굴 세부는 최소한으로.`;
}

export function svgPrompt(w: Work, index: number, artH: number, quick: boolean): string {
  const c = w.cards[index];
  const title = w.cards[0]?.title || '';
  const prev = index > 1 ? (w.cards[index - 1].text || '').slice(0, 160) : '';
  const what = c.kind === 'cover' ? '표지 그림. 이야기 전체의 무대와 핵심 사물을 한 장면에.' : `${index + 1}번째 카드 그림.`;
  return `카드소설 「${title}」의 ${what}
이 카드의 내용: ${(c.title ? c.title + ' — ' : '') + (c.text || '').slice(0, 400)}
${c.scene ? `그릴 장면(영어): ${c.scene}\n` : ''}${prev ? `앞 카드 내용(참고): ${prev}\n` : ''}글자 없이 그림만으로 상황이 읽히게.

${svgGuide(w.style)}
- 세밀하게: 큰 면(하늘·벽·바닥) → 중간 구조물 → 작은 디테일 순서로 겹쳐 그림. 그라디언트로 재질 표현.
- 장면의 핵심 사물은 화면 중앙~오른쪽에 크고 또렷하게.
- 아래쪽 1/4은 어둡고 단순하게(카드에서 글이 그 아래에 이어짐).

기술 규칙:
- <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 ${artH}"> 로 시작하는 SVG 하나만 출력. 설명·마크다운·코드펜스 금지.
- 첫 요소는 전체를 덮는 배경 rect.
- 허용: rect circle ellipse line polyline polygon path g defs linearGradient radialGradient pattern filter feGaussianBlur clipPath mask. 금지: text, image, script, style, foreignObject, 외부 href, 애니메이션.
- id는 짧게, 전부 고유하게.
${quick ? '- 길이 4~8KB, 도형 40개 이상. 생각을 길게 하지 말고 바로 그리세요.' : '- 길이 8~14KB, 도형 60개 이상.'}

구조와 밀도를 참고할 예시(장면은 새로 구성${artH !== 640 ? `; 예시는 1080×640이지만 이번 그림은 1080×${artH}` : ''}):
${SVG_EXAMPLE}`;
}

