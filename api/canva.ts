// All Canva endpoints in one function: /api/canva/<action> → here (see vercel.json).
import { router } from './_lib/router.js';
import * as callback from './_canva/callback.js';
import * as design from './_canva/design.js';
import * as exportDesign from './_canva/export.js';
import * as finishExport from './_canva/finish-export.js';
import * as finishImport from './_canva/finish-import.js';
import * as finishUpload from './_canva/finish-upload.js';
import * as login from './_canva/login.js';
import * as logout from './_canva/logout.js';
import * as page from './_canva/page.js';
import * as ret from './_canva/return.js';
import * as status from './_canva/status.js';

export const { GET, POST } = router('/api/canva', {
  login, callback, status, logout, design, export: exportDesign, return: ret,
  'finish-upload': finishUpload, 'finish-import': finishImport, 'finish-export': finishExport, page,
});
