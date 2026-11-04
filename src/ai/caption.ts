// Caption and hashtag ideas for the post: three captions with different openings and three hashtag sets
// (broad, niche, mixed), told which tags did well on the writer's earlier posts.
import { stripMarks, type Work } from '../model';
import { normTag, type TagStat } from '../posts';
import { askJSON, type TextAI } from './compose';

const str = { type: 'string' } as const;
export const CAPTION_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['captions', 'tagSets'],
  properties: {
    captions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'angle'], properties: { text: str, angle: str } } },
    tagSets: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'tags'], properties: { name: str, tags: { type: 'array', items: str } } } },
  },
};

export interface CaptionIdeas { captions: { text: string; angle: string }[]; tagSets: { name: string; tags: string[] }[] }

export function captionPrompt(w: Work, good: TagStat[] = []): string {
  const body = w.cards.filter((c) => c.kind === 'body').map((c) => stripMarks(c.text)).filter(Boolean);
  return `인스타그램 카드소설 게시물의 캡션(게시글 본문)과 해시태그를 제안합니다. 캡션 앞에는 표지 제목과 훅이 따로 붙으니 반복하지 않습니다.

[작품]
제목: ${stripMarks(w.cards[0].title) || '(없음)'}
훅: ${stripMarks(w.cards[0].text) || '(없음)'}
${w.series ? `시리즈: ${w.series}${w.episode ? ` ${w.episode}화` : ''}\n` : ''}줄거리: ${w.summary || body.slice(0, 6).join(' ')}
지금 캡션: ${w.caption || '(없음)'}
지금 해시태그: ${w.hashtags.join(' ') || '(없음)'}
${good.length ? `\n[이 계정에서 반응이 좋았던 해시태그 (평균 반응 순)]\n${good.slice(0, 12).map((g) => `${g.tag} (${g.n}번 사용)`).join(' ')}\n` : ''}
captions: 서로 다른 각도로 3개(angle에 한 단어로: 예 "질문", "분위기", "궁금증"). 각 2~5줄, 줄바꿈은 \\n.
- 첫 줄이 피드에서 잘리기 전에 눈을 붙잡게(25자 안팎).
- 결말이나 반전을 밝히지 않습니다.
- 마지막 줄은 행동 유도 한 줄(저장·댓글·팔로우 중 하나, 질문형이면 더 좋음).
- 이모지는 0~2개. 해시태그는 캡션에 넣지 않습니다.
tagSets: 3묶음. name은 "넓게"(많이 쓰는 큰 태그 위주), "좁게"(카드소설·장르·분위기 작은 태그 위주), "섞어서". 각 12~20개, #을 붙이고 띄어쓰기 없이, 한국어 위주(영어 몇 개 가능).
- 반응이 좋았던 해시태그가 있으면 어울리는 것을 섞습니다.
- 작품과 상관없는 인기 태그(#맞팔, #좋아요반사 등)는 쓰지 않습니다.`;
}

const s = (v: unknown) => (typeof v === 'string' ? v.replace(/\\n/g, '\n').trim() : '');

export function normalizeIdeas(raw: { captions?: { text?: unknown; angle?: unknown }[]; tagSets?: { name?: unknown; tags?: unknown }[] }): CaptionIdeas {
  const captions = (Array.isArray(raw.captions) ? raw.captions : [])
    .map((c) => ({ text: s(c?.text).replace(/(^|\s)#\S+/g, '').trim(), angle: s(c?.angle) }))
    .filter((c) => c.text).slice(0, 3);
  const tagSets = (Array.isArray(raw.tagSets) ? raw.tagSets : []).map((t) => ({
    name: s(t?.name) || '태그',
    tags: [...new Set((Array.isArray(t?.tags) ? t.tags : []).map((x) => normTag(String(x))).filter((x) => x.length > 1))].slice(0, 30),
  })).filter((t) => t.tags.length).slice(0, 3);
  return { captions, tagSets };
}

export async function captionIdeas(w: Work, ai: TextAI, good: TagStat[], signal?: AbortSignal): Promise<CaptionIdeas> {
  const raw = await askJSON<Parameters<typeof normalizeIdeas>[0]>(ai, captionPrompt(w, good), CAPTION_SCHEMA, signal, 4000, 'caption');
  const ideas = normalizeIdeas(raw);
  if (!ideas.captions.length && !ideas.tagSets.length) throw new Error('empty');
  return ideas;
}
