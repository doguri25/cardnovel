// POST /api/canva/finish-upload — hands the browser a short-lived token to upload the finishing deck (PPTX) straight
// to Vercel Blob (the file is larger than a function request may be). Only for a browser signed in to Canva.
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { HttpError, errorResponse, isConnected, json } from '../_lib/canva.js';
import { PPTX_MIME } from '../_lib/finish.js';

export async function POST(req: Request): Promise<Response> {
  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) throw new HttpError(503, 'blob_not_configured');
    const body = (await req.json()) as HandleUploadBody;
    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        if (!(await isConnected(req))) throw new HttpError(401, 'not_connected');
        if (!/^canva-import\/[a-z0-9]{6,40}\.pptx$/.test(pathname)) throw new HttpError(400, 'bad_path');
        return { allowedContentTypes: [PPTX_MIME], maximumSizeInBytes: 80 * 1024 * 1024, addRandomSuffix: true, validUntil: Date.now() + 10 * 60_000 };
      },
    });
    return json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
