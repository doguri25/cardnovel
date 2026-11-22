# Better Card Pictures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Korean people and settings by default in every picture AI, a one-pass scene direction, candidates for every card, and a Gemini app helper (copy prompts, paste or bulk-upload pictures).

**Architecture:** Pure prompt/assignment functions in `src/ai/prompts.ts`, `src/ai/compose.ts` and a new `src/geminiapp.ts` (unit-tested); UI in `src/main.ts`, `src/ui/cover.ts` and a new `src/ui/geminiapp.ts` (browser e2e with mocked AI).

**Tech Stack:** Vite + TypeScript PWA, vitest (jsdom), Playwright e2e scripts in the scratchpad.

**Spec:** `docs/superpowers/specs/2026-11-22-better-pictures-design.md`

## Global Constraints

- `ArtStyle.world` default exactly `한국인 · 현대 한국`; empty string means "not specified".
- English sentence for the default world: `All people are Korean, with East Asian features; the setting is contemporary South Korea (streets, homes, objects), with no readable signage.` Any other world: `People and setting: <world>.`
- New picture source `'gemini-app'`, badge label `Gemini 앱`. New usage tag `direct`, label `연출 정리`.
- User-facing text is Korean, plain; AI writing rules (HUMAN_STYLE) apply to Korean text the AI writes.
- No automation of the Gemini app itself; the helper only copies text and accepts pictures.

## Review Focus

- A work saved before this change (no `world`) loads with the default world, so old works also get Korean people. → test in Task 1.
- The writer edited 「등장인물 생김새」 by hand, then runs 연출 정리: their characters text must stay. → test in Task 2.
- Pasting text into a card's textarea must still paste text, not be taken as a picture. → test in Task 4 (paste target).
- Bulk upload of more files than cards without pictures: the extra files are left out and listed, never overwrite existing pictures. → test in Task 4.
- 연출 정리 answer naming card numbers that do not exist or skipping some: unknown numbers ignored, skipped cards keep their scene. → test in Task 2.

---

### Task 1: People and setting (world) in every picture prompt

**Files:**
- Modify: `src/model.ts` (ArtStyle, STYLE_PRESETS/presetStyle default, normalizeWork)
- Modify: `src/ai/prompts.ts` (`worldLine`, imagePrompt, canvaPrompt, characterSheetPrompt, svgPrompt, compose `characters` rule)
- Modify: `index.html` (field `#styleWorld` in 「그림체 자세히 고치기」), `src/main.ts` (renderStyle fills it; input saves `work.style.world`)
- Test: `tests/pictures.test.ts`

**Interfaces:**
- Produces: `ArtStyle.world: string`; `DEFAULT_WORLD = '한국인 · 현대 한국'` (model.ts); `worldLine(w: Work): string` (prompts.ts, '' when world empty).

- [ ] Step 1: tests — `worldLine` returns the default English sentence for `DEFAULT_WORLD` and `People and setting: 조선 시대 한양.` for that world, '' for ''; `imagePrompt`, `canvaPrompt`, `characterSheetPrompt`, `svgPrompt` each contain `worldLine(w)` when set; `normalizeWork` of a work without `style.world` gives `DEFAULT_WORLD`; `composePrompt` text tells the AI to write characters following the world (contains `인물·배경`).
- [ ] Step 2: run `npx vitest run tests/pictures.test.ts` → fails.
- [ ] Step 3: implement; in canvaPrompt put worldLine right after the characters lines; in imagePrompt after the characters line.
- [ ] Step 4: run tests → pass; `npx tsc --noEmit -p .`.
- [ ] Step 5: commit.

### Task 2: Scene direction (연출 정리)

**Files:**
- Modify: `src/ai/prompts.ts` (`DIRECT_SCHEMA`, `directPrompt(w)`), `src/ai/compose.ts` (`directWork`), `src/model.ts` (ArtStyle `charactersByWriter?: boolean`, `directedFor?: string`), `src/ai/providers.ts` + `src/usage.ts` (tag `direct`)
- Modify: `index.html` (button `#btnDirect` 「연출 정리」 in the style box), `src/main.ts` (button, `#styleChars` input sets `charactersByWriter = true`, drawAll confirm offers 연출 정리 when `directedFor !== textSig(work)` and a text AI exists)
- Test: `tests/pictures.test.ts`

**Interfaces:**
- Consumes: `worldLine` (Task 1), `SCENE_RULE`, `askJSON`.
- Produces: `directWork(w: Work, ai: TextAI, signal?: AbortSignal): Promise<{ scenes: number; characters: boolean }>`; `DIRECT_SCHEMA = { characters: string, scenes: [{ card: integer, scene: string }] }`.

- [ ] Step 1: tests (mock fetch like tests/scenes.test.ts) — after `directWork`: every card in the answer gets `scene` and `sceneFor = text`; unknown card numbers ignored; cards missing from the answer keep their scene; `style.characters` replaced only when `charactersByWriter` is not true; `style.directedFor === textSig(w)`; one request; `directPrompt` contains the world line, every card's text with its number, the current characters and `SCENE_RULE`.
- [ ] Step 2: run → fails.
- [ ] Step 3: implement (`askJSON(..., 8000, 'direct')`).
- [ ] Step 4: run → pass; tsc.
- [ ] Step 5: commit.

### Task 3: Candidates for every picture card

**Files:**
- Modify: `src/ai/compose.ts` (`CARD_VARIANTS`), `src/ui/cover.ts` (`openCandidates(app, index, refs, label, price, onPicked)`; preview renders card `index`), `src/main.ts` (button 「후보」 on every non-outro card when the provider can draw; action `cands`)
- Test: browser e2e (Task 5)

**Interfaces:**
- Produces: `CARD_VARIANTS: string[]` (2 items: medium shot of the characters' faces / wide shot of the place and mood); `openCandidates(app: App, index: number, refs: () => CardRefs | null, label: string, price: number | null, onPicked: () => void): Promise<void>` (cover uses `COVER_VARIANTS`, body cards `CARD_VARIANTS`).

- [ ] Step 1: generalize cover.ts; keep cover behaviour (3 compositions) and the Canva usage wording.
- [ ] Step 2: tsc + full vitest pass.
- [ ] Step 3: commit.

### Task 4: Gemini app helper, paste and bulk upload

**Files:**
- Create: `src/geminiapp.ts` (pure: `geminiFirstMessage(w)`, `geminiCardPrompt(w, i)`, `assignFiles(files, targets)`, `pasteTarget(active, selected)`)
- Create: `src/ui/geminiapp.ts` (modal `openGeminiHelper(app)`)
- Modify: `src/model.ts` (ImgSource + `'gemini-app'`), `src/main.ts` (IMG_NAME, art-bar button `#btnGeminiApp`, global paste handler, `setCardPicture(i, dataUrl, source)` shared with onUpload, App methods the modal needs), `index.html` (button 「Gemini 앱으로 그리기」 in `#artBar`)
- Test: `tests/geminiapp.test.ts`

**Interfaces:**
- Consumes: `worldLine` (Task 1), `canvaAspect`/`artAspect`, `parseCharacters`, `directWork` (Task 2, offered from the modal).
- Produces: `geminiFirstMessage(w: Work, count: number): string`; `geminiCardPrompt(w: Work, i: number): string`; `assignFiles<T extends { lastModified: number; name: string }>(files: T[], targets: number[]): { pairs: { file: T; index: number }[]; extra: T[] }`; `pasteTarget(active: Element | null, selected: number): number | null` (null when focus is in an input/textarea/contenteditable).

- [ ] Step 1: tests — first message contains count, style prompt, world line, characters, the no-text rule and "인물 기준 그림을 먼저"; card prompt contains `NN번 카드`, the card's scene, only the characters named in it (or the lone one), the ratio words for the card's art area (`가로 16:9` for a stack card in 1:1), and no title text for the cover; `assignFiles` sorts by lastModified then name, fills targets in order, puts the rest in `extra`; `pasteTarget` returns null for a focused textarea/input, else the selected card.
- [ ] Step 2: run → fails.
- [ ] Step 3: implement pure functions; then the modal (sections ① 준비 ② 카드별 [복사][붙여넣기 대상] ③ 한꺼번에 올리기 → order review with drag and remove → 카드에 넣기; 인물 기준 그림 올리기/붙여넣기) and the paste handler (clipboardData image → `setCardPicture(target, url, 'gemini-app' when the helper is open else 'upload')`).
- [ ] Step 4: run tests → pass; tsc.
- [ ] Step 5: commit.

### Task 5: Browser e2e, README, deploy

- [ ] Step 1: e2e with mocked AI: world field default and edit reach the Canva prompt; 연출 정리 runs one request and updates scenes; 「후보」 on a body card draws 2 and picking sets the picture; helper: copy texts (clipboard permission granted), bulk upload 3 files into the right cards, paste an image onto the selected card, text paste into a textarea untouched; no page errors; phone width no overflow.
- [ ] Step 2: earlier e2e scripts still pass (new-work, review-preview, round7, canva-ai).
- [ ] Step 3: README rows; commit; push; Vercel production deploy; verify.
