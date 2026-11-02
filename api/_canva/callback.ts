// GET /api/canva/callback — Canva sends the user back here with a one-time code; it becomes a stored token.
import { clearPkce, exchangeCode, readPkce, redirect } from '../_lib/canva.js';

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const back = (reason: string) => redirect(`/?canva=error&reason=${encodeURIComponent(reason)}`, [clearPkce()]);
  const err = url.searchParams.get('error');
  if (err) return back(err);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const pkce = await readPkce(req).catch(() => null);
  if (!code || !state || !pkce || pkce.s !== state) return back('state');
  try {
    const tokenCookies = await exchangeCode(code, pkce.v);
    return redirect('/?canva=connected', [...tokenCookies, clearPkce()]);
  } catch (e) {
    return back(e instanceof Error ? e.message.slice(0, 80) : 'token');
  }
}
