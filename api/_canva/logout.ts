// POST /api/canva/logout — forgets the Canva token in this browser.
import { clearToken, json } from '../_lib/canva.js';

export function POST(): Response {
  return json({ connected: false }, 200, clearToken());
}
