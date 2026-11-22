// Gemini 앱 도우미, the pure part: what the writer copies into the Gemini app (one chat for the whole story, so the
// people stay the same), and where the pictures coming back go. The app itself is never driven from here.
import { artAspect, layoutOf } from './ai/compose';
import { sceneStale } from './scene';
import { parseCharacters, scenePeople, worldLine } from './ai/prompts';
import { canvaAspect } from './canva';
import { stripMarks, type Work } from './model';

const RATIO_WORDS: Record<string, string> = {
  landscape: '가로 16:9', landscape_3_2: '가로 3:2', square: '정사각형 1:1',
  portrait_4_5: '세로 4:5', portrait_2_3: '세로 2:3', portrait: '세로 9:16',
};
const FRAME_WORDS = {
  stack: '넓게 잡은 장면, 중심 인물은 가운데보다 살짝 오른쪽. 아래 가장자리는 어둡고 단순하게.',
  full: '그림 위에 글이 올라가요. 중심 대상은 위쪽에 두고, 아래 3분의 1은 어둡고 차분하게 비워 주세요.',
  quote: '글 뒤에 깔리는 배경이에요. 뚜렷한 대상 없이 흐릿하고 분위기 있게.',
} as const;

const num = (i: number) => String(i + 1).padStart(2, '0');
const line = (x: string) => (/[.!?]$/.test(x) ? x : `${x}.`);

/** The words for the shape of card `i`'s picture area, e.g. 「가로 16:9」. */
export const ratioWords = (w: Work, i: number): string => RATIO_WORDS[canvaAspect(artAspect(w, i))] ?? '정사각형 1:1';

/** The message that starts a new Gemini chat: the run, the art style, people and setting, the looks, the rules. */
export function geminiFirstMessage(w: Work, count: number): string {
  const s = w.style;
  const title = stripMarks(w.cards[0]?.title ?? '').trim();
  const { named, general } = parseCharacters(s.characters);
  const looks = [...named.map((p) => line(`${p.name}: ${p.desc}`)), general].filter(Boolean);
  const world = (s.world ?? '').trim();
  return [
    `이 대화에서 인스타그램 카드소설${title ? ` 「${title}」` : ''}에 들어갈 그림 ${count}장을 한 장씩 차례로 그려 주세요. 제가 카드마다 지시문을 하나씩 보낼게요.`,
    `[그림체]\n${s.prompt.trim() || '이야기 분위기에 맞는 차분한 일러스트.'}`,
    world ? `[인물·배경]\n${world}\n${worldLine(w)}` : '',
    `[인물 생김새] 모든 그림에서 똑같이 유지해 주세요.\n${looks.length ? looks.join('\n') : '이야기에 맞게 인물마다 뚜렷한 생김새(나이·얼굴·머리·옷차림)를 정해 주세요.'}`,
    [
      '[규칙]',
      '- 그림 안에 글자·말풍선·숫자·로고·워터마크를 넣지 마세요. 글은 제가 따로 얹어요.',
      '- 인물의 얼굴·머리·체형·옷차림을 모든 그림에서 똑같이 유지해 주세요. 같은 장소는 같은 모습으로.',
      '- 지시문 하나에 그림 한 장만 그리고, 적힌 비율을 지켜 주세요.',
      '- 지시문의 장면(영어)에 적힌 것만 그려 주세요.',
    ].join('\n'),
    s.refImage
      ? '먼저: 함께 올린 인물 기준 그림을 보고 인물들의 모습을 익혀 주세요. 이번에는 그림을 그리지 말고 "준비됐어요"라고만 답해 주세요.'
      : '먼저: 인물 기준 그림을 먼저 한 장 그려 주세요. 주요 인물이 나란히 선 전신 정면 모습, 밝은 단색 배경, 글자 없이. 다음 그림들은 이 인물들의 모습을 그대로 따라 주세요.',
  ].filter(Boolean).join('\n\n');
}

/** One card's prompt: its number, its scene, only the people in it, the framing and the shape. Never the title. */
export function geminiCardPrompt(w: Work, i: number): string {
  const c = w.cards[i];
  // a scene written for words that have changed a lot since would show the wrong moment: go by the words then
  const scene = sceneStale(c) ? '' : c.scene.trim();
  const { people, general } = scenePeople(w, scene || c.scene || c.text);
  return [
    `${num(i)}번 카드${c.kind === 'cover' ? '(표지)' : ''}`,
    scene ? `장면: ${line(scene)}` : `장면: 이 카드의 글에 맞는 한 순간 — ${stripMarks(c.text).trim()}`,
    ...(people.length ? ['인물:', ...people.map((p) => `- ${line(`${p.name}: ${p.desc}`)}`)] : []),
    general ? `인물 참고: ${general}` : '',
    // the people and setting again on every card, so a chat started again mid-way keeps them
    (w.style.world ?? '').trim() ? `인물·배경: ${(w.style.world ?? '').trim()}` : '',
    `구도: ${FRAME_WORDS[layoutOf(c)]}`,
    `비율: ${ratioWords(w, i)}`,
    '그림 안에 글자 없이, 그림만 한 장 그려 주세요.',
  ].filter(Boolean).join('\n');
}

/** Pictures uploaded together, in the order they were made (then by name, "2" before "10"), onto `targets` in order;
 *  files beyond the targets are left out (`extra`), never put over a card that has a picture. */
export function assignFiles<T extends { lastModified: number; name: string }>(files: T[], targets: number[]): { pairs: { file: T; index: number }[]; extra: T[] } {
  const sorted = [...files].sort((a, b) => a.lastModified - b.lastModified || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return {
    pairs: sorted.slice(0, targets.length).map((file, k) => ({ file, index: targets[k] })),
    extra: sorted.slice(targets.length),
  };
}

/** The picture in a paste: browsers put it in `files`, some only in `items`. Null when the paste holds none. */
export function pastedImage(dt: DataTransfer | null | undefined): File | null {
  if (!dt) return null;
  const f = Array.from(dt.files ?? []).find((x) => x.type.startsWith('image/'));
  if (f) return f;
  for (const it of Array.from(dt.items ?? [])) {
    if (it.kind === 'file' && it.type.startsWith('image/')) { const g = it.getAsFile(); if (g) return g; }
  }
  return null;
}

const NOT_TEXT = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color', 'image', 'hidden']);

/** The card a pasted picture goes onto: the selected one, or none while the writer is typing in a text field. */
export function pasteTarget(active: Element | null, selected: number): number | null {
  if (active) {
    const tag = active.tagName;
    if (tag === 'TEXTAREA') return null;
    // a field that takes words; a checkbox, button or file field just clicked does not
    if (tag === 'INPUT' && !NOT_TEXT.has(((active as HTMLInputElement).type || 'text').toLowerCase())) return null;
    if (active.closest('[contenteditable]:not([contenteditable="false"])')) return null;
  }
  return selected;
}
