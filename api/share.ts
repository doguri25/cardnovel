// All share-link endpoints in one function: /api/share/<action> and /s/<id> → here (see vercel.json).
import { router } from './_lib/router.js';
import * as create from './_share/create.js';
import * as del from './_share/delete.js';
import * as page from './_share/page.js';
import * as status from './_share/status.js';
import * as upload from './_share/upload.js';

export const { GET, POST } = router('/api/share', { status, upload, create, delete: del, page });
