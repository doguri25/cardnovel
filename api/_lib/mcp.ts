// A small client for Canva's MCP server, the connection AI assistants use for Canva AI (generate-image and friends).
// Streamable HTTP with JSON-RPC 2.0: every request opens a session (initialize), then makes one tool call. The user's
// own Canva Connect token is sent as the bearer token, so pictures count against the user's Canva AI allowance.
import { HttpError } from './canva.js';

/** Where Canva's MCP server is: CANVA_MCP_URL when set, else the developer address, then the public one.
 *  The one that answered is remembered while the function stays warm. */
const MCP_URLS = ['https://api.canva.com/connect/v1/mcp', 'https://mcp.canva.com/mcp'];
let working: string | undefined;
export const mcpUrls = (): string[] => (process.env.CANVA_MCP_URL ? [process.env.CANVA_MCP_URL] : working ? [working, ...MCP_URLS.filter((u) => u !== working)] : MCP_URLS);
/** for tests */
export const resetMcpUrl = (): void => { working = undefined; };
const PROTOCOL = '2025-06-18';

export interface ToolContent { type: string; text?: string; data?: string; mimeType?: string; uri?: string; resource?: { uri?: string; blob?: string; text?: string; mimeType?: string } }
export interface ToolResult { content?: ToolContent[]; structuredContent?: Record<string, unknown>; isError?: boolean }
interface RpcMessage { jsonrpc?: string; id?: number | string; result?: unknown; error?: { code?: number; message?: string } }

/** Messages in a response body: plain JSON, or Server-Sent Events whose `data:` lines carry JSON-RPC messages. */
export function readMessages(body: string, contentType: string): RpcMessage[] {
  if (!/text\/event-stream/i.test(contentType)) {
    if (!body.trim()) return [];
    const v = JSON.parse(body) as RpcMessage | RpcMessage[];
    return Array.isArray(v) ? v : [v];
  }
  const out: RpcMessage[] = [];
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
    if (!data) continue;
    try { out.push(JSON.parse(data) as RpcMessage); } catch { /* keep-alive or partial event */ }
  }
  return out;
}

function failure(status: number, text: string): HttpError {
  if (status === 401) return new HttpError(401, 'mcp_unauthorized', text.slice(0, 300));
  if (status === 403) return new HttpError(403, 'mcp_forbidden', text.slice(0, 300));
  if (status === 404) return new HttpError(502, 'mcp_unavailable', text.slice(0, 300));
  if (status === 429) return new HttpError(429, 'too_many_requests', text.slice(0, 300));
  return new HttpError(502, 'mcp_error', `MCP ${status}: ${text.slice(0, 300)}`);
}

interface Session { url: string; token: string; id?: string; next: number }

async function post(s: Session, payload: Record<string, unknown>, initialized: boolean): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${s.token}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (initialized) headers['mcp-protocol-version'] = PROTOCOL;
  if (s.id) headers['mcp-session-id'] = s.id;
  let res: Response;
  try {
    res = await fetch(s.url, { method: 'POST', headers, body: JSON.stringify(payload) });
  } catch (e) {
    throw new HttpError(502, 'mcp_unavailable', String((e as Error)?.message || e));
  }
  return res;
}

async function request(s: Session, method: string, params: Record<string, unknown>, initialized = true): Promise<unknown> {
  const id = s.next++;
  const res = await post(s, { jsonrpc: '2.0', id, method, params }, initialized);
  const text = await res.text();
  if (!res.ok) throw failure(res.status, text);
  const sid = res.headers.get('mcp-session-id');
  if (sid) s.id = sid;
  let messages: RpcMessage[];
  try { messages = readMessages(text, res.headers.get('content-type') || ''); } catch { throw new HttpError(502, 'mcp_error', 'unreadable MCP response'); }
  const reply = messages.find((m) => m.id === id) ?? messages.find((m) => m.result !== undefined || m.error);
  if (!reply) throw new HttpError(502, 'mcp_error', 'no MCP reply');
  if (reply.error) {
    const msg = reply.error.message || 'MCP error';
    throw new HttpError(/unauthori[sz]ed|forbidden|scope|permission/i.test(msg) ? 403 : 502, /unauthori[sz]ed|forbidden|scope|permission/i.test(msg) ? 'mcp_forbidden' : 'mcp_error', msg);
  }
  return reply.result;
}

/** Opens a session with the user's token (at the first address that exists) and calls one tool. */
export async function callTool(token: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  let s: Session | undefined;
  let last: unknown;
  for (const url of mcpUrls()) {
    const tryS: Session = { url, token, next: 1 };
    try {
      await request(tryS, 'initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'cardnovel', version: '1.0' } }, false);
      s = tryS;
      working = url;
      break;
    } catch (e) {
      last = e;
      if (!(e instanceof HttpError && e.code === 'mcp_unavailable')) throw e; // only a missing address moves on
    }
  }
  if (!s) throw last;
  const note = await post(s, { jsonrpc: '2.0', method: 'notifications/initialized' }, true);
  if (!note.ok && note.status !== 202) throw failure(note.status, await note.text());
  return ((await request(s, 'tools/call', { name, arguments: args })) ?? {}) as ToolResult;
}

/* ---------- reading tool results (Canva may answer in structured content, JSON text, or both) ---------- */
const texts = (r: ToolResult): string[] => (r.content ?? []).map((c) => c.text ?? c.resource?.text ?? '').filter(Boolean);

/** The structured result, or the first text item that is JSON. */
export function resultJson(r: ToolResult): Record<string, unknown> {
  if (r.structuredContent && typeof r.structuredContent === 'object') return r.structuredContent;
  for (const t of texts(r)) {
    try { const v = JSON.parse(t); if (v && typeof v === 'object') return v as Record<string, unknown>; } catch { /* plain text */ }
  }
  return {};
}

/** Looks through nested objects for the first string under any of `keys`. */
export function pick(obj: unknown, keys: string[], depth = 0): string | undefined {
  if (!obj || typeof obj !== 'object' || depth > 5) return undefined;
  for (const k of keys) {
    const v = (obj as Record<string, unknown>)[k];
    if (typeof v === 'string' && v) return v;
  }
  for (const v of Object.values(obj as Record<string, unknown>)) {
    const found = Array.isArray(v) ? v.map((x) => pick(x, keys, depth + 1)).find(Boolean) : pick(v, keys, depth + 1);
    if (found) return found;
  }
  return undefined;
}

export function jobIdOf(r: ToolResult): string | undefined {
  const j = resultJson(r);
  return pick(j, ['jobId', 'job_id']) ?? pick(j, ['id']) ?? texts(r).map((t) => /"?job_?id"?\s*[:=]\s*"?([A-Za-z0-9_-]{4,})/i.exec(t)?.[1]).find(Boolean);
}

export interface JobOutcome { status: 'pending' | 'success' | 'failure'; url?: string; data?: string; mediaId?: string; message?: string }

/** Inline pictures past this size are not passed on (a Vercel response tops out at 4.5 MB); the link is awaited instead. */
export const MAX_INLINE = 4_000_000;

/** Every https link anywhere in a value. */
function links(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6) return out;
  if (typeof v === 'string') {
    for (const m of v.matchAll(/https:\/\/[^\s"'<>)\]]+/g)) out.push(m[0]);
  } else if (Array.isArray(v)) v.forEach((x) => links(x, out, depth + 1));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => links(x, out, depth + 1));
  return out;
}

/** A link to the picture file itself: not a canva.com web page (the "Open generated image" link), a picture file first. */
export function imageLink(candidates: string[]): string | undefined {
  const files = candidates.filter((u) => {
    try { return !/^(www\.)?canva\.com$/i.test(new URL(u).hostname); } catch { return false; }
  });
  return files.find((u) => /\.(png|jpe?g|webp)$/i.test(new URL(u).pathname)) ?? files[0];
}

/** What a get-generate-image-job answer says: still working, the picture (inline, or a link to fetch), or why it failed. */
export function jobOutcome(r: ToolResult): JobOutcome {
  const j = resultJson(r);
  const raw = (pick(j, ['status', 'state']) ?? '').toUpperCase();
  const reason = pick(j, ['failureMessage', 'failure_message', 'failureType', 'failure_type', 'message', 'error']);
  if (r.isError || /FAIL|ERROR|CANCEL/.test(raw)) return { status: 'failure', message: (reason ?? texts(r).join(' ')).slice(0, 300) };
  const mediaId = pick(j, ['media_id', 'mediaId']);
  const content = r.content ?? [];
  const image = content.find((c) => c.type === 'image' && c.data);
  const blob = content.find((c) => c.type === 'resource' && c.resource?.blob && /^image\//.test(c.resource.mimeType || ''));
  const data = image ? `data:${image.mimeType || 'image/png'};base64,${image.data}` : blob ? `data:${blob.resource!.mimeType};base64,${blob.resource!.blob}` : undefined;
  const fromContent = content.flatMap((c) => [c.uri, c.resource?.uri].filter((u): u is string => !!u && u.startsWith('https://')));
  const link = imageLink([...fromContent, ...links(j), ...links(texts(r))]);
  const done = /SUCCE|DONE|COMPLETE/.test(raw) || (!raw && !!(data || link));
  if (!done) return { status: 'pending' };
  if (data && data.length <= MAX_INLINE) return { status: 'success', data, mediaId };
  if (link) return { status: 'success', url: link, mediaId };
  return { status: 'pending', mediaId }; // finished, but the picture link is not ready yet
}
