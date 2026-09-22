import { sha256Hex, hmacHex, timingSafeEqual, getCookie, verifySessionToken, SESSION_COOKIE, SESSION_TTL_MS } from '../functions/_utils.js';

export const config = {
  runtime: 'edge'
};

export default async function handler(request) {
  const url = new URL(request.url);
  const env = process.env;

  if (url.pathname === '/api/login' && request.method === 'POST') {
    return handleLogin(request, env);
  }
  if (url.pathname === '/api/session' && request.method === 'GET') {
    return handleSession(request, env);
  }
  if (url.pathname === '/api/logout' && request.method === 'POST') {
    return handleLogout();
  }
  if (url.pathname === '/api/publish' && request.method === 'POST') {
    return handlePublish(request, env);
  }
  if (url.pathname === '/api/ingest' && request.method === 'POST') {
    return handleIngest(request, env);
  }

  return jsonResponse({ ok: false, error: 'Not found.' }, 404);
}

function jsonResponse(obj, status = 200, extraHeaders = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  for (const [k, v] of Object.entries(extraHeaders)) headers.append(k, v);
  return new Response(JSON.stringify(obj), { status, headers });
}

async function handleLogin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Bad request body.' }, 400);
  }

  const username = (body && body.username) || '';
  const password = (body && body.password) || '';
  if (!username || !password) {
    return jsonResponse({ ok: false, error: 'Missing username or password.' }, 400);
  }

  const expectedUser = env.ADMIN_USERNAME || '';
  const expectedHash = env.ADMIN_PASSWORD_HASH || '';
  const secret = env.SESSION_SECRET || '';
  if (!expectedUser || !expectedHash || !secret) {
    return jsonResponse(
      { ok: false, error: 'Server missing ADMIN_USERNAME / ADMIN_PASSWORD_HASH / SESSION_SECRET env vars.' },
      500
    );
  }

  const gotHash = await sha256Hex(password);
  const userOk = timingSafeEqual(username, expectedUser);
  const passOk = timingSafeEqual(gotHash, expectedHash);
  if (!userOk || !passOk) {
    await new Promise((r) => setTimeout(r, 400));
    return jsonResponse({ ok: false, error: 'Invalid username or password.' }, 401);
  }

  const exp = Date.now() + SESSION_TTL_MS;
  const sig = await hmacHex(secret, String(exp));
  const token = `${exp}.${sig}`;
  const cookie = `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
  return jsonResponse({ ok: true }, 200, { 'Set-Cookie': cookie });
}

async function handleSession(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  const secret = env.SESSION_SECRET || '';
  const ok = secret ? await verifySessionToken(token, secret) : false;
  return jsonResponse({ loggedIn: ok });
}

async function handleLogout() {
  const cookie = `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
  return jsonResponse({ ok: true }, 200, { 'Set-Cookie': cookie });
}

async function handlePublish(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  const secret = env.SESSION_SECRET || '';
  const loggedIn = secret ? await verifySessionToken(token, secret) : false;
  if (!loggedIn) {
    return jsonResponse({ ok: false, error: 'Not logged in.' }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Bad request body.' }, 400);
  }
  if (!body || !Array.isArray(body.trades)) {
    return jsonResponse({ ok: false, error: 'Missing trades array in request body.' }, 400);
  }

  return commitToGitHub(env, {
    trades: body.trades,
    dailySummaries: body.dailySummaries || []
  }, `Update data.json via admin panel (${new Date().toISOString()})`);
}

async function handleIngest(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const secret = env.INGEST_SECRET || '';

  if (!secret || !timingSafeEqual(token, secret)) {
    return jsonResponse({ ok: false, error: 'Unauthorized ingest secret.' }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Bad request body.' }, 400);
  }

  if (!body || !Array.isArray(body.trades)) {
    return jsonResponse({ ok: false, error: 'Missing trades array.' }, 400);
  }

  return commitToGitHub(env, {
    trades: body.trades,
    dailySummaries: body.dailySummaries || []
  }, `Sync trades from Discord bot (${new Date().toISOString()})`, body.trades.length);
}

async function commitToGitHub(env, dataObj, commitMsg, incomingCount = 0) {
  const ghToken = env.GITHUB_TOKEN || '';
  const ghRepo = env.GITHUB_REPO || '';
  const ghBranch = env.GITHUB_BRANCH || 'main';
  const ghPath = env.GITHUB_DATA_PATH || 'data.json';

  if (!ghToken || !ghRepo) {
    return jsonResponse(
      { ok: false, error: 'Server missing GITHUB_TOKEN / GITHUB_REPO env vars.' },
      500
    );
  }

  const payloadStr = JSON.stringify(dataObj, null, 1);
  const contentB64 = toBase64Utf8(payloadStr);
  const apiUrl = `https://api.github.com/repos/${ghRepo}/contents/${encodeURIComponent(ghPath)}`;
  const ghHeaders = {
    Authorization: `Bearer ${ghToken}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'swinger-tracker',
    'X-GitHub-Api-Version': '2022-11-28'
  };

  let sha;
  try {
    const getRes = await fetch(`${apiUrl}?ref=${encodeURIComponent(ghBranch)}`, { headers: ghHeaders });
    if (getRes.status === 200) {
      const j = await getRes.json();
      sha = j.sha;
    } else if (getRes.status !== 404) {
      const errText = await getRes.text();
      return jsonResponse({ ok: false, error: `GitHub API error (${getRes.status}): ${errText}` }, 502);
    }
  } catch (e) {
    return jsonResponse({ ok: false, error: 'Could not reach GitHub API: ' + e.message }, 502);
  }

  try {
    const putRes = await fetch(apiUrl, {
      method: 'PUT',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: commitMsg,
        content: contentB64,
        branch: ghBranch,
        ...(sha ? { sha } : {})
      })
    });
    const putJson = await putRes.json().catch(() => ({}));
    if (putRes.status !== 200 && putRes.status !== 201) {
      return jsonResponse({ ok: false, error: `GitHub API commit error (${putRes.status}): ${putJson.message || 'unknown'}` }, 502);
    }
    const commitUrl = putJson && putJson.commit && putJson.commit.html_url;
    return jsonResponse({
      ok: true,
      commitUrl: commitUrl || null,
      totalTradesCount: dataObj.trades.length,
      newTradesCount: incomingCount
    });
  } catch (e) {
    return jsonResponse({ ok: false, error: 'Could not commit to GitHub: ' + e.message }, 502);
  }
}

function toBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
