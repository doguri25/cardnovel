// GET /api/canva/login — starts the Canva sign-in (OAuth 2.0 with PKCE).
import { AUTHORIZE_URL, SCOPES, env, errorResponse, pkceChallenge, pkceCookie, randomToken, redirect } from '../_lib/canva.js';

export async function GET(): Promise<Response> {
  try {
    const verifier = randomToken(48);
    const state = randomToken(24);
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('code_challenge', await pkceChallenge(verifier));
    url.searchParams.set('code_challenge_method', 's256');
    url.searchParams.set('scope', SCOPES);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', env('CANVA_CLIENT_ID'));
    url.searchParams.set('state', state);
    url.searchParams.set('redirect_uri', env('CANVA_REDIRECT_URI'));
    return redirect(url.toString(), [await pkceCookie({ v: verifier, s: state })]);
  } catch (e) {
    return errorResponse(e);
  }
}
