// Small DOM helpers: lookups, escaping, toast and modal dialogs.

export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let toastTimer = 0;
export interface ToastAction { label: string; run: () => void }
/** A short notice at the bottom. With `action` it carries one button (for example 「되돌리기」) and stays a little longer. */
export function toast(msg: string, ms = 3200, action?: ToastAction): void {
  const t = $('toast');
  t.textContent = '';
  const text = document.createElement('span');
  text.textContent = msg;
  t.appendChild(text);
  t.classList.toggle('has-action', !!action);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action.label;
    b.addEventListener('click', () => { t.classList.remove('show'); clearTimeout(toastTimer); action.run(); }, { once: true });
    t.appendChild(b);
  }
  t.classList.add('show');
  clearTimeout(toastTimer);
  const hide = () => t.classList.remove('show');
  toastTimer = window.setTimeout(hide, action ? Math.max(ms, 6500) : ms);
}

export function setStatus(el: HTMLElement, msg: string, kind: '' | 'busy' | 'error' = ''): void {
  el.textContent = msg;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

type Closer = () => void;
let closeCurrent: Closer | null = null;

/** Opens the shared modal with the given HTML; `wire` attaches handlers. Returns a function that closes it. */
export function openModal(html: string, opts: { size?: '' | 'mid' | 'wide'; wire?: (box: HTMLElement, close: Closer) => void; onClose?: () => void } = {}): Closer {
  closeCurrent?.();
  const modal = $('modal'), box = $('modalBox');
  const opener = document.activeElement as HTMLElement | null;
  box.className = 'box' + (opts.size ? ' ' + opts.size : '');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.innerHTML = html;
  const heading = box.querySelector('h2');
  if (heading) { heading.id = heading.id || 'modalTitle'; box.setAttribute('aria-labelledby', heading.id); } else box.removeAttribute('aria-labelledby');
  modal.hidden = false;
  const focusables = () => Array.from(box.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter((el) => el.offsetParent !== null);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { close(); return; }
    if (e.key !== 'Tab') return;
    // keep Tab inside the dialog
    const f = focusables();
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  const onBackdrop = (e: MouseEvent) => { if (e.target === modal) close(); };
  const close: Closer = () => {
    modal.hidden = true;
    box.innerHTML = '';
    document.removeEventListener('keydown', onKey);
    modal.removeEventListener('click', onBackdrop);
    if (closeCurrent === close) closeCurrent = null;
    opts.onClose?.();
    // back to where the writer was, unless another dialog opened meanwhile
    if (!closeCurrent && opener && document.contains(opener)) { try { opener.focus({ preventScroll: true }); } catch { /* fine */ } }
  };
  document.addEventListener('keydown', onKey);
  modal.addEventListener('click', onBackdrop);
  closeCurrent = close;
  opts.wire?.(box, close);
  const auto = box.querySelector<HTMLElement>('[autofocus]');
  if (auto) auto.focus(); else if (!box.contains(document.activeElement)) { box.tabIndex = -1; box.focus({ preventScroll: true }); }
  return close;
}

export function confirmBox(msg: string, opts: { ok?: string; cancel?: string; detail?: string[] } = {}): Promise<boolean> {
  return new Promise((res) => {
    let answered = false;
    openModal(
      `<p>${esc(msg)}</p>${opts.detail?.length ? `<ul class="changes">${opts.detail.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}
       <div class="toolbar"><button class="btn" type="button" data-a="no">${esc(opts.cancel ?? '취소')}</button><button class="btn primary" type="button" data-a="yes" autofocus>${esc(opts.ok ?? '확인')}</button></div>`,
      {
        wire: (box, close) => {
          box.querySelector('[data-a="no"]')!.addEventListener('click', () => { answered = true; res(false); close(); });
          box.querySelector('[data-a="yes"]')!.addEventListener('click', () => { answered = true; res(true); close(); });
        },
        onClose: () => { if (!answered) res(false); },
      },
    );
  });
}

export function promptBox(msg: string, opts: { placeholder?: string; ok?: string; value?: string } = {}): Promise<string | null> {
  return new Promise((res) => {
    let answered = false;
    openModal(
      `<p>${esc(msg)}</p>
       <input class="input" id="promptInput" placeholder="${esc(opts.placeholder ?? '')}" value="${esc(opts.value ?? '')}" autofocus>
       <div class="toolbar" style="margin-top:16px"><button class="btn" type="button" data-a="no">취소</button><button class="btn primary" type="button" data-a="yes">${esc(opts.ok ?? '확인')}</button></div>`,
      {
        wire: (box, close) => {
          const input = box.querySelector<HTMLInputElement>('#promptInput')!;
          const yes = () => { answered = true; res(input.value.trim()); close(); };
          input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) yes(); });
          box.querySelector('[data-a="no"]')!.addEventListener('click', () => { answered = true; res(null); close(); });
          box.querySelector('[data-a="yes"]')!.addEventListener('click', yes);
        },
        onClose: () => { if (!answered) res(null); },
      },
    );
  });
}

export const pad2 = (n: number): string => String(n).padStart(2, '0');
export const fmtTime = (ms: number): string => { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
export const fmtDate = (ms: number): string => { const d = new Date(ms || 0); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
