// 빠른 실행 (Ctrl/⌘+K): type a few letters — or just the initial consonants, like ㄱㅈ for 교정 — and run any
// action, jump to a step or to a card.
import { score } from '../hangul';
import { esc, openModal } from './dom';

export interface Command {
  id: string;
  title: string;
  group: string;
  /** more words it can be found by */
  keywords?: string;
  hint?: string;
  run: () => void;
}

const RECENT_KEY = 'cardnovel.recentCommands';
const recent = (): string[] => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; } };
const remember = (id: string) => { try { localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recent().filter((x) => x !== id)].slice(0, 6))); } catch { /* fine */ } };

/** Best matches first; a number finds that card. Without a query: recent commands, then the rest in order. */
export function rankCommands(all: Command[], query: string): Command[] {
  const q = query.trim();
  if (!q) {
    const r = recent();
    const head = r.map((id) => all.find((c) => c.id === id)).filter((c): c is Command => !!c);
    return [...head, ...all.filter((c) => !r.includes(c.id) && !c.id.startsWith('card:'))];
  }
  const n = /^\d{1,2}$/.test(q) ? Number(q) : 0;
  return all
    .map((c) => {
      let s = Math.max(score(c.title, q), c.keywords ? score(c.keywords, q) - 10 : -1);
      if (n && c.id === `card:${n - 1}`) s = 1000;
      return { c, s };
    })
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.c);
}

export function openPalette(commands: () => Command[]): void {
  const all = commands();
  let shown: Command[] = [];
  let at = 0;
  openModal(`
    <div class="palette">
      <input class="input" id="palInput" placeholder="무엇을 할까요? 예: 교정, 릴스, 3번 카드, ㅅㅈ(설정)" autocomplete="off" spellcheck="false" aria-label="빠른 실행" role="combobox" aria-controls="palList" aria-expanded="true" autofocus>
      <ul id="palList" role="listbox"></ul>
      <p class="hint">↑↓로 고르고 Enter · Esc로 닫기 · 어디서든 Ctrl+K (맥은 ⌘K)</p>
    </div>`, {
    size: 'mid',
    wire: (box, close) => {
      const input = box.querySelector<HTMLInputElement>('#palInput')!;
      const list = box.querySelector<HTMLElement>('#palList')!;
      const paint = () => {
        shown = rankCommands(all, input.value).slice(0, 40);
        at = Math.min(at, Math.max(0, shown.length - 1));
        let lastGroup = '';
        list.innerHTML = shown.length ? shown.map((c, i) => {
          const head = !input.value.trim() && c.group !== lastGroup ? `<li class="grp" role="presentation">${esc(c.group)}</li>` : '';
          lastGroup = c.group;
          return `${head}<li role="option" id="pal-${i}" data-i="${i}" aria-selected="${i === at}" class="${i === at ? 'on' : ''}"><span>${esc(c.title)}</span>${c.hint ? `<small>${esc(c.hint)}</small>` : input.value.trim() ? `<small>${esc(c.group)}</small>` : ''}</li>`;
        }).join('') : '<li class="none">맞는 것이 없어요.</li>';
        input.setAttribute('aria-activedescendant', shown.length ? `pal-${at}` : '');
        list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
      };
      const run = (i: number) => {
        const c = shown[i];
        if (!c) return;
        remember(c.id);
        close();
        setTimeout(() => c.run(), 0);
      };
      input.addEventListener('input', () => { at = 0; paint(); });
      input.addEventListener('keydown', (e) => {
        if (e.isComposing) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); at = Math.min(shown.length - 1, at + 1); paint(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); at = Math.max(0, at - 1); paint(); }
        else if (e.key === 'Enter') { e.preventDefault(); run(at); }
      });
      list.addEventListener('click', (e) => { const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-i]'); if (li) run(Number(li.dataset.i)); });
      list.addEventListener('mousemove', (e) => {
        const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-i]');
        if (li && Number(li.dataset.i) !== at) { at = Number(li.dataset.i); list.querySelectorAll('li[data-i]').forEach((x) => { const on = Number((x as HTMLElement).dataset.i) === at; x.classList.toggle('on', on); x.setAttribute('aria-selected', String(on)); }); }
      });
      paint();
    },
  });
}
