// Shared helpers for the Canva Connect serverless functions (Vercel, Web Request/Response handlers).
// Tokens never reach the browser's JavaScript: they live in an encrypted, HttpOnly cookie scoped to /api/canva.

export const CANVA_API = 'https://api.canva.com/rest/v1';
export const AUTHORIZE_URL = 'https://www.canva.com/api/oauth/authorize';
export const KEYS_URL = 'https://api.canva.com/rest/v1/connect/keys';
export const SCOPES = 'asset:read asset:write design:content:read design:content:write design:meta:read';

/** the old single token cookie (still read, always cleared): a large Canva token made it too big for browsers */
const TOKEN_COOKIE = 'cn_tok';
/** the token now lives in pieces cn_t0, cn_t1, … each well under the 4 KB a browser keeps per cookie */
const PIECE_PREFIX = 'cn_t';
const PIECE_SIZE = 3800;
const MAX_PIECES = 6;
const PKCE_COOKIE = 'cn_pkce';
const COOKIE_PATH = '/api/canva';

export function env(name: 'CANVA_CLIENT_ID' | 'CANVA_CLIENT_SECRET' | 'CANVA_REDIRECT_URI' | 'SESSION_SECRET'): string {
  const v = process.env[name];
  if (!v) throw new HttpError(500, 'server_not_configured', `${name} is not set`);
  return v;
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message = code) { super(message); }
}

/* ---------- base64url ---------- */
export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}
export const randomToken = (n = 32): string => b64url(crypto.getRandomValues(new Uint8Array(n)));

/* ---------- PKCE ---------- */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

/* ---------- encrypted cookies (AES-GCM, key = SHA-256 of SESSION_SECRET) ---------- */
async function aesKey(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(value: unknown, secret: string): Promise<string> {
  return sealBytes(new TextEncoder().encode(JSON.stringify(value)), secret);
}
async function sealBytes(data: Uint8Array<ArrayBuffer>, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), data));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv); out.set(ct, iv.length);
  return b64url(out);
}
async function unsealBytes(sealed: string, secret: string): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const all = fromB64url(sealed);
    const iv = all.slice(0, 12), ct = all.slice(12);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await aesKey(secret), ct));
  } catch {
    return null;
  }
}
export async function unseal<T>(sealed: string, secret: string): Promise<T | null> {
  const pt = await unsealBytes(sealed, secret);
  if (!pt) return null;
  try { return JSON.parse(new TextDecoder().decode(pt)) as T; } catch { return null; }
}

/* ---------- deflate (tokens are long base64 text and shrink by about a quarter) ---------- */
async function pipe(data: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(stream)).arrayBuffer());
}
/** 'z' + sealed deflated JSON, or 'p' + sealed JSON where compression is not available */
export async function sealCompact(value: unknown, secret: string): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(value));
  if (typeof CompressionStream === 'function') {
    try { return 'z' + (await sealBytes(await pipe(json, new CompressionStream('deflate')), secret)); } catch { /* fall back to plain */ }
  }
  return 'p' + (await sealBytes(json, secret));
}
export async function unsealCompact<T>(sealed: string, secret: string): Promise<T | null> {
  const kind = sealed[0];
  const pt = await unsealBytes(sealed.slice(1), secret);
  if (!pt) return null;
  try {
    const text = kind === 'z' ? new TextDecoder().decode(await pipe(pt, new DecompressionStream('deflate'))) : new TextDecoder().decode(pt);
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie') || '';
  for (const part of header.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}
export const cookie = (name: string, value: string, maxAge: number): string =>
  `${name}=${encodeURIComponent(value)}; Path=${COOKIE_PATH}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
export const clearCookie = (name: string): string => `${name}=; Path=${COOKIE_PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

/* ---------- responses ---------- */
export const json = (body: unknown, status = 200, setCookies: string[] = []): Response => {
  const h = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  setCookies.forEach((c) => h.append('set-cookie', c));
  return new Response(JSON.stringify(body), { status, headers: h });
};
export const redirect = (location: string, setCookies: string[] = []): Response => {
  const h = new Headers({ location, 'cache-control': 'no-store' });
  setCookies.forEach((c) => h.append('set-cookie', c));
  return new Response(null, { status: 302, headers: h });
};
export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return json({ error: e.code, message: e.message }, e.status);
  return json({ error: 'internal_error', message: String(e) }, 500);
}

/* ---------- PKCE state cookie ---------- */
export interface PkceState { v: string; s: string }
export const pkceCookie = async (p: PkceState): Promise<string> => cookie(PKCE_COOKIE, await seal(p, env('SESSION_SECRET')), 600);
export const readPkce = async (req: Request): Promise<PkceState | null> => {
  const c = readCookie(req, PKCE_COOKIE);
  return c ? unseal<PkceState>(c, env('SESSION_SECRET')) : null;
};
export const clearPkce = (): string => clearCookie(PKCE_COOKIE);

/* ---------- tokens ---------- */
interface TokenSet { a: string; r: string; e: number }

async function tokenRequest(params: Record<string, string>): Promise<TokenSet> {
  const basic = btoa(`${env('CANVA_CLIENT_ID')}:${env('CANVA_CLIENT_SECRET')}`);
  const res = await fetch(`${CANVA_API}/oauth/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string; code?: string; message?: string };
  if (!res.ok || !body.access_token) {
    throw new HttpError(res.status === 400 || res.status === 401 ? 401 : 502, 'token_failed', body.error_description || body.message || body.error || body.code || `token ${res.status}`);
  }
  return { a: body.access_token, r: body.refresh_token || params.refresh_token || '', e: Date.now() + (body.expires_in ?? 3600) * 1000 };
}

/** Set-Cookie headers for the exchanged token. */
export async function exchangeCode(code: string, verifier: string): Promise<string[]> {
  const t = await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: env('CANVA_REDIRECT_URI') });
  return tokenCookies(t);
}
const TOKEN_MAX_AGE = 60 * 60 * 24 * 90;
/** The token, compressed and sealed, split over as many pieces as it needs; unused pieces and the old cookie are cleared. */
export async function tokenCookies(t: TokenSet): Promise<string[]> {
  const sealed = await sealCompact(t, env('SESSION_SECRET'));
  const pieces = sealed.match(new RegExp(`.{1,${PIECE_SIZE}}`, 'g')) ?? [];
  if (pieces.length > MAX_PIECES) throw new HttpError(502, 'token_too_large', 'Canva token does not fit in cookies');
  return [
    ...pieces.map((p, i) => cookie(PIECE_PREFIX + i, p, TOKEN_MAX_AGE)),
    ...Array.from({ length: MAX_PIECES - pieces.length }, (_, k) => clearCookie(PIECE_PREFIX + (pieces.length + k))),
    clearCookie(TOKEN_COOKIE),
  ];
}
/** Logout: every piece and the old single cookie. */
export const clearToken = (): string[] => [...Array.from({ length: MAX_PIECES }, (_, i) => clearCookie(PIECE_PREFIX + i)), clearCookie(TOKEN_COOKIE)];

async function readToken(req: Request): Promise<TokenSet | null> {
  const pieces: string[] = [];
  for (let i = 0; i < MAX_PIECES; i++) {
    const p = readCookie(req, PIECE_PREFIX + i);
    if (!p) break;
    pieces.push(p);
  }
  if (pieces.length) return unsealCompact<TokenSet>(pieces.join(''), env('SESSION_SECRET'));
  const old = readCookie(req, TOKEN_COOKIE);
  return old ? unseal<TokenSet>(old, env('SESSION_SECRET')) : null;
}

/** The user's access token, refreshed when it is about to expire. `setCookies` carries a renewed cookie back. */
export async function accessToken(req: Request): Promise<{ token: string; setCookies: string[] }> {
  const t = await readToken(req);
  if (!t) throw new HttpError(401, 'not_connected', 'Canva is not connected');
  if (t.e - Date.now() > 60_000) return { token: t.a, setCookies: [] };
  if (!t.r) throw new HttpError(401, 'not_connected', 'Canva session expired');
  // refresh tokens are single-use: the new one replaces the old one in the cookie
  const fresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.r });
  return { token: fresh.a, setCookies: await tokenCookies(fresh) };
}

export const isConnected = async (req: Request): Promise<boolean> => !!(await readToken(req));

/* ---------- Canva REST calls ---------- */
export async function canva<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${CANVA_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) },
  });
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { message: text.slice(0, 300) }; }
  if (!res.ok) {
    const b = body as { code?: string; message?: string } | null;
    const code = res.status === 401 ? 'not_connected' : b?.code || `canva_${res.status}`;
    throw new HttpError(res.status === 401 ? 401 : res.status === 429 ? 429 : 502, code, b?.message || code);
  }
  return body as T;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Polls an asynchronous Canva job until it is no longer in progress. */
export async function pollJob<T extends { job: { status: string } }>(token: string, path: string, timeoutMs = 45_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  let wait = 700;
  for (;;) {
    const r = await canva<T>(token, path);
    if (r.job.status !== 'in_progress') return r;
    if (Date.now() > until) throw new HttpError(504, 'job_timeout', 'Canva took too long');
    await sleep(wait);
    wait = Math.min(2000, wait * 1.5);
  }
}

/* ---------- return navigation: verify the correlation JWT with Canva's public keys ---------- */
export interface Correlation { design_id: string; correlation_state?: string; aud?: string; exp?: number; type?: string }

export async function verifyCorrelationJwt(jwt: string, fetchKeys: () => Promise<{ keys: JsonWebKey[] }> = defaultKeys): Promise<Correlation> {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new HttpError(400, 'bad_return', 'malformed token');
  const header = JSON.parse(new TextDecoder().decode(fromB64url(parts[0]))) as { alg?: string; kid?: string };
  const payload = JSON.parse(new TextDecoder().decode(fromB64url(parts[1]))) as Correlation;
  const { keys } = await fetchKeys();
  const jwk = (keys as (JsonWebKey & { kid?: string })[]).find((k) => !header.kid || k.kid === header.kid);
  if (!jwk) throw new HttpError(400, 'bad_return', 'unknown signing key');
  const alg = header.alg || jwk.alg || 'RS256';
  let ok = false;
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const sig = fromB64url(parts[2]);
  if (alg === 'RS256') {
    const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
  } else if (alg === 'ES256') {
    const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, data);
  } else {
    throw new HttpError(400, 'bad_return', `unsupported alg ${alg}`);
  }
  if (!ok) throw new HttpError(400, 'bad_return', 'bad signature');
  if (payload.aud && payload.aud !== env('CANVA_CLIENT_ID')) throw new HttpError(400, 'bad_return', 'wrong audience');
  if (payload.exp && payload.exp * 1000 < Date.now()) throw new HttpError(400, 'bad_return', 'expired');
  if (payload.type && payload.type !== 'rti') throw new HttpError(400, 'bad_return', 'wrong type');
  if (!payload.design_id) throw new HttpError(400, 'bad_return', 'no design');
  return payload;
}
async function defaultKeys(): Promise<{ keys: JsonWebKey[] }> {
  const res = await fetch(KEYS_URL);
  if (!res.ok) throw new HttpError(502, 'keys_failed', `keys ${res.status}`);
  return res.json() as Promise<{ keys: JsonWebKey[] }>;
}

/** Card state passed through Canva and back: "<work id>~<card id>", at most 50 URL-safe characters. */
export const isValidState = (s: string): boolean => /^[A-Za-z0-9_~.-]{1,50}$/.test(s);
