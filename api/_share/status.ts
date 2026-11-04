// GET /api/share/status — are share links set up on the server, and is this key right?
import { errorResponse, json } from '../_lib/canva.js';
import { checkKey, shareKeyConfigured } from '../_lib/share.js';

export async function GET(req: Request): Promise<Response> {
  try {
    if (!shareKeyConfigured()) return json({ enabled: false, keyOk: false });
    let keyOk = false;
    try { await checkKey(req); keyOk = true; } catch { /* wrong or missing key */ }
    return json({ enabled: true, keyOk });
  } catch (e) {
    return errorResponse(e);
  }
}
