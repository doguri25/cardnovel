// POST /api/canva/design — makes a Canva design the size of a card's picture area, with the current picture
// placed in it, and returns its edit URL (with the card's state for return navigation).
import { HttpError, accessToken, canva, errorResponse, isValidState, json, pollJob } from '../_lib/canva.js';

interface Body { width?: number; height?: number; title?: string; image?: string; state?: string }
interface UploadJob { job: { id: string; status: string; asset?: { id: string }; error?: { code: string; message: string } } }
interface DesignResponse { design: { id: string; urls: { edit_url: string } } }

const MAX_BYTES = 3_500_000;

export async function POST(req: Request): Promise<Response> {
  let cookies: string[] = [];
  try {
    const body = (await req.json().catch(() => ({}))) as Body;
    const width = Math.round(Number(body.width)), height = Math.round(Number(body.height));
    if (!(width >= 40 && width <= 8000 && height >= 40 && height <= 8000)) throw new HttpError(400, 'bad_size');
    const state = String(body.state || '');
    if (!isValidState(state)) throw new HttpError(400, 'bad_state');
    const title = String(body.title || '카드소설 그림').slice(0, 50);
    // the picture is checked before the token is touched, so a refused picture never uses up a refresh
    let bytes: Uint8Array<ArrayBuffer> | undefined;
    if (body.image) {
      const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(body.image);
      if (!m) throw new HttpError(400, 'bad_image', 'PNG or JPEG data URL expected');
      bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
      if (bytes.length > MAX_BYTES) throw new HttpError(413, 'image_too_large');
    }
    const { token, setCookies } = await accessToken(req);
    cookies = setCookies;

    let assetId: string | undefined;
    if (bytes) {
      const nameB64 = btoa(String.fromCharCode(...new TextEncoder().encode(title)));
      const started = await canva<UploadJob>(token, '/asset-uploads', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'Asset-Upload-Metadata': JSON.stringify({ name_base64: nameB64 }) },
        body: bytes,
      });
      const done = started.job.status === 'in_progress' ? await pollJob<UploadJob>(token, `/asset-uploads/${encodeURIComponent(started.job.id)}`, 30_000) : started;
      if (done.job.status !== 'success' || !done.job.asset) throw new HttpError(502, 'upload_failed', done.job.error?.message || 'upload failed');
      assetId = done.job.asset.id;
    }

    const created = await canva<DesignResponse>(token, '/designs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'type_and_asset', design_type: { type: 'custom', width, height }, ...(assetId ? { asset_id: assetId } : {}), title }),
    });
    const edit = new URL(created.design.urls.edit_url);
    edit.searchParams.set('correlation_state', state);
    return json({ designId: created.design.id, editUrl: edit.toString() }, 200, cookies);
  } catch (e) {
    return errorResponse(e, cookies);
  }
}
