// GET /api/canva/status — is this browser connected to Canva?
import { errorResponse, isConnected, json } from '../_lib/canva.js';

export async function GET(req: Request): Promise<Response> {
  try {
    return json({ connected: await isConnected(req) });
  } catch (e) {
    return errorResponse(e);
  }
}
