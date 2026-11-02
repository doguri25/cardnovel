// @vitest-environment node
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { b64url, pkceChallenge, seal, unseal, verifyCorrelationJwt } from '../api/_lib/canva';
import { GET as login } from '../api/canva/login';
import { GET as callback } from '../api/canva/callback';
import { POST as design } from '../api/canva/design';
import { POST as exportDesign } from '../api/canva/export';
import { GET as status } from '../api/canva/status';

const SECRET = 'test-session-secret-0123456789abcdef';
beforeAll(() => {
  process.env.CANVA_CLIENT_ID = 'OC-test';
  process.env.CANVA_CLIENT_SECRET = 'cnvca-test';
  process.env.CANVA_REDIRECT_URI = 'https://cardnovel.vercel.app/api/canva/callback';
  process.env.SESSION_SECRET = SECRET;
});
afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const tokenCookie = async (exp = Date.now() + 3600_000) => `cn_tok=${encodeURIComponent(await seal({ a: 'ACCESS', r: 'REFRESH', e: exp }, SECRET))}`;

describe('helpers', () => {
  it('seals and unseals, and refuses another secret', async () => {
    const s = await seal({ x: 1 }, SECRET);
    expect(await unseal(s, SECRET)).toEqual({ x: 1 });
    expect(await unseal(s, 'other')).toBeNull();
  });
  it('PKCE challenge matches the RFC 7636 example', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('correlation JWT', () => {
  const make = async (payload: Record<string, unknown>) => {
    const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    const jwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1' };
    const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
    const head = enc({ alg: 'RS256', kid: 'k1' }), body = enc(payload);
    const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, new TextEncoder().encode(`${head}.${body}`)));
    return { jwt: `${head}.${body}.${b64url(sig)}`, keys: async () => ({ keys: [jwk] }) };
  };
  const ok = { aud: 'OC-test', type: 'rti', design_id: 'DAF123', correlation_state: 'w1~c1', exp: Math.floor(Date.now() / 1000) + 3600 };
  it('accepts a token signed by Canva’s key', async () => {
    const { jwt, keys } = await make(ok);
    expect(await verifyCorrelationJwt(jwt, keys)).toMatchObject({ design_id: 'DAF123', correlation_state: 'w1~c1' });
  });
  it('rejects a changed payload', async () => {
    const { jwt, keys } = await make(ok);
    const [h, , s] = jwt.split('.');
    const forged = `${h}.${b64url(new TextEncoder().encode(JSON.stringify({ ...ok, design_id: 'OTHER' })))}.${s}`;
    await expect(verifyCorrelationJwt(forged, keys)).rejects.toThrow();
  });
  it('rejects another app’s token', async () => {
    const { jwt, keys } = await make({ ...ok, aud: 'OC-someone-else' });
    await expect(verifyCorrelationJwt(jwt, keys)).rejects.toThrow(/audience/);
  });
});

describe('routes', () => {
  it('login redirects to Canva with PKCE and stores the verifier in a cookie', async () => {
    const res = await login();
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe('https://www.canva.com/api/oauth/authorize');
    expect(loc.searchParams.get('client_id')).toBe('OC-test');
    expect(loc.searchParams.get('code_challenge_method')).toBe('s256');
    expect(loc.searchParams.get('redirect_uri')).toBe('https://cardnovel.vercel.app/api/canva/callback');
    expect(loc.searchParams.get('scope')).toContain('design:content:write');
    expect(res.headers.get('set-cookie')).toMatch(/^cn_pkce=.*HttpOnly; Secure; SameSite=Lax/);
  });
  it('callback refuses a state that does not match', async () => {
    const res = await callback(new Request('https://cardnovel.vercel.app/api/canva/callback?code=abc&state=wrong'));
    expect(res.headers.get('location')).toBe('/?canva=error&reason=state');
  });
  it('callback exchanges the code and stores the token', async () => {
    const lres = await login();
    const pk = lres.headers.get('set-cookie')!.split(';')[0];
    const state = new URL(lres.headers.get('location')!).searchParams.get('state');
    const fetchMock = vi.fn(async () => json({ access_token: 'A', refresh_token: 'R', expires_in: 14400 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await callback(new Request(`https://cardnovel.vercel.app/api/canva/callback?code=abc&state=${state}`, { headers: { cookie: pk } }));
    expect(res.headers.get('location')).toBe('/?canva=connected');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.canva.com/rest/v1/oauth/token');
    expect((init.headers as Record<string, string>).Authorization).toBe('Basic ' + btoa('OC-test:cnvca-test'));
    expect(String(init.body)).toContain('grant_type=authorization_code');
    expect(res.headers.get('set-cookie')).toContain('cn_tok=');
  });
  it('status says whether the token cookie is there', async () => {
    expect(await (await status(new Request('https://x/api/canva/status'))).json()).toEqual({ connected: false });
    expect(await (await status(new Request('https://x/api/canva/status', { headers: { cookie: await tokenCookie() } }))).json()).toEqual({ connected: true });
  });
  it('design uploads the picture, creates a custom design and adds correlation_state', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method || 'GET'} ${url}`);
      if (url.endsWith('/asset-uploads')) {
        expect(JSON.parse((init!.headers as Record<string, string>)['Asset-Upload-Metadata']).name_base64).toBeTruthy();
        return json({ job: { id: 'j1', status: 'in_progress' } });
      }
      if (url.endsWith('/asset-uploads/j1')) return json({ job: { id: 'j1', status: 'success', asset: { id: 'A1' } } });
      if (url.endsWith('/designs')) {
        expect(JSON.parse(String(init!.body))).toMatchObject({ type: 'type_and_asset', design_type: { type: 'custom', width: 1080, height: 640 }, asset_id: 'A1' });
        return json({ design: { id: 'D1', urls: { edit_url: 'https://www.canva.com/api/design/xyz' } } });
      }
      return json({}, 404);
    }));
    const req = new Request('https://x/api/canva/design', {
      method: 'POST', headers: { cookie: await tokenCookie(), 'content-type': 'application/json' },
      body: JSON.stringify({ width: 1080, height: 640, title: '마지막 버스 03', image: 'data:image/jpeg;base64,/9j/4AAQ', state: 'w1~c1' }),
    });
    const res = await design(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.designId).toBe('D1');
    expect(new URL(body.editUrl).searchParams.get('correlation_state')).toBe('w1~c1');
    expect(calls).toEqual(['POST https://api.canva.com/rest/v1/asset-uploads', 'GET https://api.canva.com/rest/v1/asset-uploads/j1', 'POST https://api.canva.com/rest/v1/designs']);
  });
  it('design says not_connected without a token', async () => {
    const res = await design(new Request('https://x/api/canva/design', { method: 'POST', body: JSON.stringify({ width: 1080, height: 640, state: 'w1~c1' }) }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('not_connected');
  });
  it('an expiring token is refreshed and the new cookie is sent back', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/oauth/token')) return json({ access_token: 'A2', refresh_token: 'R2', expires_in: 14400 });
      if (url.endsWith('/designs')) return json({ design: { id: 'D2', urls: { edit_url: 'https://www.canva.com/api/design/abc' } } });
      return json({}, 404);
    }));
    const res = await design(new Request('https://x/api/canva/design', {
      method: 'POST', headers: { cookie: await tokenCookie(Date.now() + 1000) }, body: JSON.stringify({ width: 1080, height: 640, state: 'w1~c1' }),
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('cn_tok=');
  });
  it('export waits for the job and returns the PNG bytes', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/exports')) return json({ job: { id: 'e1', status: 'in_progress' } });
      if (url.endsWith('/exports/e1')) return json({ job: { id: 'e1', status: 'success', urls: ['https://export-download.canva.com/x.png'] } });
      if (url.startsWith('https://export-download')) return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
      return json({}, 404);
    }));
    const res = await exportDesign(new Request('https://x/api/canva/export', { method: 'POST', headers: { cookie: await tokenCookie() }, body: JSON.stringify({ designId: 'D1' }) }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
  });
});
