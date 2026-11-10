// The Hobby plan allows 12 functions per deployment, so each group of endpoints is one function:
// /api/canva/<action> and /api/share/<action> (and /s/<id>) are rewritten to it (vercel.json).
import { json } from './canva.js';

export type Handler = (req: Request) => Response | Promise<Response>;
export interface Route { GET?: Handler; POST?: Handler }

/** The action from ?action= (after the rewrite) or from the path (when the original URL is passed through). */
export function actionOf(req: Request, prefix: string): string {
  const u = new URL(req.url);
  const q = u.searchParams.get('action');
  if (q) return q;
  if (u.pathname.startsWith('/s/')) return 'page';
  return u.pathname.startsWith(prefix + '/') ? u.pathname.slice(prefix.length + 1).split('/')[0] : '';
}

export function router(prefix: string, routes: Record<string, Route>) {
  const go = (method: 'GET' | 'POST') => async (req: Request): Promise<Response> => {
    const a = actionOf(req, prefix);
    const route = Object.prototype.hasOwnProperty.call(routes, a) ? routes[a] : undefined;
    if (!route) return json({ error: 'not_found' }, 404);
    const h = route[method];
    if (!h) return json({ error: 'method_not_allowed' }, 405);
    return h(req);
  };
  return { GET: go('GET'), POST: go('POST') };
}
