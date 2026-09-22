// Cloudflare Worker entry point.
//
// Cloudflare's current dashboard flow ("Workers & Pages -> Connect to Git")
// creates a *Worker*, not a classic Pages project -- so the old
// functions/api/*.js "Pages Functions" convention is never picked up, and
// a Worker with no `main` script attached is static-assets-only, which is
// exactly why "Variables cannot be added to a Worker that only has static
// assets" shows up. This file is the fix: it's a real Worker script, wired
// up in wrangler.json as `main`, so the Worker has actual code -- which is
// what unlocks Settings -> Variables and secrets in the dashboard.
//
// Routing: wrangler.json sets `assets.run_worker_first: ["/api/*"]`, so
// everything under /api/* comes here first; everything else (index.html,
// style.css, app.js, parser.js, data.json) is served directly from the
// assets binding without ever running this code.

import { sha256Hex, hmacHex, timingSafeEqual, jsonResponse, getCookie, verifySessionToken, SESSION_COOKIE, SESSION_TTL_MS } from './functions/_utils.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

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

    // Anything else under /api/* that doesn't match a known route.
    if (url.pathname.startsWith('/api/')) {
      return jsonResponse({ ok: false, error: 'Not found.' }, 404);
    }

    // Shouldn't normally get here (run_worker_first is scoped to /api/*),
    // but fall back to serving assets just in case.
    return env.ASSETS.fetch(request);
  }
};

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
      { ok: false, error: 'Server missing ADMIN_USERNAME / ADMIN_PASSWORD_HASH / SESSION_SECRET env vars. Set them in this Worker\'s Settings -> Variables and secrets.' },
      500
    );
  }

  const gotHash = await sha256Hex(password);
  const userOk = timingSafeEqual(username, expectedUser);
  const passOk = timingSafeEqual(gotHash, expectedHash);
  if (!userOk || !passOk) {
    await new Promise((r) => setTimeout(r, 400)); // slow naive brute-forcing
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

// POST /api/publish { trades, dailySummaries }
// Requires a valid admin session (same cookie as the rest of the panel).
// Commits the merged data.json straight to the GitHub repo via the GitHub
// REST API, using a personal access token stored as the GITHUB_TOKEN env
// var -- so a login + one click replaces "download data.json, git add,
// git commit, git push" by hand.
async function handlePublish(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  const secret = env.SESSION_SECRET || '';
  const loggedIn = secret ? await verifySessionToken(token, secret) : false;
  if (!loggedIn) {
    return jsonResponse({ ok: false, error: 'Not logged in.' }, 401);
  }

  const ghToken = env.GITHUB_TOKEN || '';
  const ghRepo = env.GITHUB_REPO || ''; // "owner/repo"
  const ghBranch = env.GITHUB_BRANCH || 'main';
  const ghPath = env.GITHUB_DATA_PATH || 'data.json';
  if (!ghToken || !ghRepo) {
    return jsonResponse(
      { ok: false, error: 'Server missing GITHUB_TOKEN / GITHUB_REPO env vars. Set them in this Worker\'s Settings -> Variables and secrets, then redeploy. See README.md.' },
      500
    );
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

  const payloadStr = JSON.stringify({ trades: body.trades, dailySummaries: body.dailySummaries || [] }, null, 1);
  const contentB64 = toBase64Utf8(payloadStr);

  const apiUrl = `https://api.github.com/repos/${ghRepo}/contents/${encodeURIComponent(ghPath)}`;
  const ghHeaders = {
    Authorization: `Bearer ${ghToken}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'mordy-tracker-worker',
    'X-GitHub-Api-Version': '2022-11-28'
  };

  // Need the current file's sha to update it (GitHub requires this for
  // updating an existing file; a 404 means the file doesn't exist yet,
  // which is also fine -- we just create it).
  let sha;
  try {
    const getRes = await fetch(`${apiUrl}?ref=${encodeURIComponent(ghBranch)}`, { headers: ghHeaders });
    if (getRes.status === 200) {
      const j = await getRes.json();
      sha = j.sha;
    } else if (getRes.status !== 404) {
      const errText = await getRes.text();
      return jsonResponse({ ok: false, error: `GitHub API error reading current file (${getRes.status}): ${errText}` }, 502);
    }
  } catch (e) {
    return jsonResponse({ ok: false, error: 'Could not reach GitHub API: ' + e.message }, 502);
  }

  try {
    const putRes = await fetch(apiUrl, {
      method: 'PUT',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Update ${ghPath} via admin panel (${new Date().toISOString()})`,
        content: contentB64,
        branch: ghBranch,
        ...(sha ? { sha } : {})
      })
    });
    const putJson = await putRes.json().catch(() => ({}));
    if (putRes.status !== 200 && putRes.status !== 201) {
      return jsonResponse({ ok: false, error: `GitHub API error committing (${putRes.status}): ${putJson.message || 'unknown error'}` }, 502);
    }
    const commitUrl = putJson && putJson.commit && putJson.commit.html_url;
    return jsonResponse({ ok: true, commitUrl: commitUrl || null });
  } catch (e) {
    return jsonResponse({ ok: false, error: 'Could not reach GitHub API: ' + e.message }, 502);
  }
}

function toBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
