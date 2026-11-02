// GET /api/canva/return — Canva's 「Return」 button lands here with a signed token naming the design.
import { isValidState, redirect, verifyCorrelationJwt } from '../_lib/canva.js';

export async function GET(req: Request): Promise<Response> {
  const jwt = new URL(req.url).searchParams.get('correlation_jwt') || '';
  try {
    const c = await verifyCorrelationJwt(jwt);
    const state = c.correlation_state && isValidState(c.correlation_state) ? c.correlation_state : '';
    return redirect(`/?canva=return&design=${encodeURIComponent(c.design_id)}&state=${encodeURIComponent(state)}`);
  } catch {
    return redirect('/?canva=error&reason=return');
  }
}
