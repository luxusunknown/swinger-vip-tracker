# Mr. Swinger VIP — Analyst Tracker

A site that tracks every analyst's calls from the "Mr. Swinger" VIP #trade-recaps
Discord channel and computes win rate, profit factor, avg $/trade, worst
loss, and more — per analyst, with a date-range filter and charts.

The dashboard itself is static HTML/CSS/JS. The admin login is real
server-side auth: a small Cloudflare Worker script checks your
username/password against environment variables and never ships anything
secret to the browser.

## Why this looks different from a "plain static site"

Cloudflare's dashboard ("Workers & Pages → Connect to Git") now creates a
**Worker**, not the older, separate "Pages" product — and a Worker that has
no actual script attached (just files) is "static-assets-only," which is
exactly why you hit **"Variables cannot be added to a Worker that only has
static assets."** There's no code running server-side yet, so there's
nowhere for an environment variable to go.

The fix is `worker.js` + `wrangler.json` in this repo: a real (tiny) Worker
script that handles `/api/login`, `/api/session`, and `/api/logout`, and
hands everything else (`index.html`, `style.css`, `app.js`, `parser.js`,
`data.json`) straight to Cloudflare's static-asset serving. Once that
script is deployed, the Worker isn't "static-assets-only" anymore, and
Settings → Variables and secrets unlocks.

## Files

- `index.html` / `style.css` / `app.js` / `parser.js` — the dashboard
- `data.json` — the actual trade data (this is what changes every day)
- `worker.js` — the Worker script: login/session/logout/publish, everything
  else falls through to static files
- `wrangler.json` — tells Cloudflare about `worker.js` and where the static
  files live
- `functions/_utils.js` — crypto helpers `worker.js` imports (hashing,
  signing the session cookie)
- `.assetsignore` — keeps `worker.js`/`wrangler.json`/this README out of
  the public static-file listing

## 1. Fix the project name in `wrangler.json`

Open `wrangler.json` and check the `"name"` field says exactly
**`analysts-data-io`** (or whatever your Worker is actually named in the
Cloudflare dashboard — the breadcrumb at the top of the page shows it).
These have to match exactly or the deploy will fail with a name-mismatch
error.

## 2. Push to GitHub

```
git add .
git commit -m "add worker.js for real server-side admin auth"
git push
```

Since your repo is already connected to this Cloudflare project, this push
should trigger a new deployment automatically (check the **Deployments**
tab). If it doesn't build (see step 3 for the settings it expects), trigger
one manually with **New deployment** (top right, per your screenshot).

## 3. Check the build/deploy settings

In the Cloudflare project → **Settings → Builds**:
- **Build command:** leave empty (there's no compile step here)
- **Deploy command:** `npx wrangler deploy` (this is the default — only
  change it if it's set to something else)

## 4. Set the real secrets

Once `worker.js` has actually deployed, go back to **Settings → Variables
and secrets** — it should no longer show the "static assets only" message.
Add these three:

| Variable | Value |
|---|---|
| `ADMIN_USERNAME` | whatever username you want to log in with |
| `ADMIN_PASSWORD_HASH` | the SHA-256 hash of your password (see below — **not** the plain password) |
| `SESSION_SECRET` | a long random string (signs the login session — treat it like a password) |

To get the SHA-256 hash of your chosen password, open any browser's dev
console (F12 → Console) and run:

```js
crypto.subtle.digest('SHA-256', new TextEncoder().encode('yourpassword'))
  .then(b => console.log([...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')))
```

Copy the hex string it prints → that's your `ADMIN_PASSWORD_HASH`. For
`SESSION_SECRET`, run `crypto.randomUUID() + crypto.randomUUID()` in that
same console and paste the result.

Mark `ADMIN_PASSWORD_HASH` and `SESSION_SECRET` as **"Encrypt"** (secret)
when adding them, not plain text variables — that keeps them hidden even
from your own dashboard view after saving. After adding all three, hit
**New deployment** once more so the running Worker picks them up.

### Is this actually secure now?

Yes, meaningfully more than a client-side check: the password comparison
happens inside `worker.js`, on Cloudflare's server, using real crypto — the
browser only ever gets back "yes" or "no." A few honest caveats:
- Your password is only as strong as what you pick.
- There's a built-in 400ms delay on a wrong guess to slow naive
  brute-forcing, but for real protection also add a **Cloudflare rate
  limiting rule** on `/api/login` (dashboard → Security → WAF → Rate
  limiting rules — free tier covers this).
- The session cookie is HttpOnly + Secure + SameSite=Strict and expires
  after 12 hours.

## 5. Set up one-click publishing (optional but recommended)

By default, "Publish to GitHub" needs three more env vars so `worker.js`
can commit on your behalf via GitHub's API. Without these it'll show an
error telling you what's missing; the "Download data.json instead" button
always works regardless.

1. On GitHub: **your avatar → Settings → Developer settings → Personal
   access tokens → Fine-grained tokens → Generate new token.**
2. **Repository access:** "Only select repositories" → pick this one repo
   specifically (never "All repositories" — you want this token useless
   everywhere else if it ever leaked).
3. **Permissions → Repository permissions → Contents:** set to
   **Read and write**. Leave everything else as No access.
4. Generate it, copy the token (starts with `github_pat_...`) — you won't
   see it again.
5. Back in Cloudflare, add these env vars (mark the token as **"Encrypt"**):

| Variable | Value |
|---|---|
| `GITHUB_TOKEN` | the fine-grained token from above |
| `GITHUB_REPO` | `yourusername/your-repo-name` |
| `GITHUB_BRANCH` | `main` (optional — defaults to `main` if you skip it) |

6. Redeploy once so the Worker picks them up.

The token can only touch the one repo you scoped it to, and only read/write
its contents — not delete the repo, not touch your other repos, not manage
your account. Still, treat it like any other credential: if you ever need
to revoke it, delete it from GitHub's token settings and generate a new one
(then update the Cloudflare env var).

## 6. Your daily update workflow

Each day, once the new recap posts in Discord:

1. Download the recap page from Discord (or copy the text/HTML directly —
   the parser handles either).
2. On the live site, click **Admin**, log in with your real
   username/password.
3. Drop the file onto the upload box (or paste text into it) → **Parse**.
   You get a preview of what it found and how many are genuinely new (it
   skips anything already in `data.json`, so it's safe to re-upload
   overlapping content if you're not sure exactly where you left off).
4. Click **Merge into page** — updates the dashboard in your browser so you
   can sanity-check it before it goes live.
5. Click **Publish to GitHub** — commits the updated `data.json` straight
   to your repo. Cloudflare auto-redeploys in under a minute and the public
   site shows the new day for everyone. (No GitHub setup from step 5 yet?
   Use **Download data.json instead** and commit it by hand, same as
   before.)

   Forgot to click "Merge into page" before hitting Publish? It's fine —
   Publish (and Download) now fold in anything you parsed but didn't merge
   yet automatically, and the confirmation message tells you how many new
   calls it swept in. The publish confirmation always shows the total trade
   count that just went out, so you can eyeball that it's more than before.

You can drop in multiple days at once (catching up after a few days away)
— it splits on each day's recap header automatically.

## What counts as a "day" in the filters

The 7/14/20/30/60-day filters count the last N days the channel actually
posted a recap, not N calendar days — weekends/off days don't shrink the
window.

## Notes on the data

- Every number is computed straight from the emoji-marked win/loss lines in
  each analyst's `CALLS:` section, not from the channel's own daily "Total
  Trades / Winrate" footer (which blends every analyst together for the
  day). Both exist in `data.json` if you want to cross-check (`trades` vs
  `dailySummaries`).
- "Avg $ / Trade" is total profit ÷ trades that had a dollar figure — wins
  and losses blended, i.e. the expected outcome of one typical call.
- "Avg Contract Cost" is the average entry price × 100 — roughly what one
  contract costs to open, not the average realized loss (most losers get
  cut before the option goes to zero, so realized losses usually run
  smaller than this number).
- A handful of very old-format entries don't include a dollar figure (just
  a % and a win/loss marker) — those count toward win rate but not toward
  profit totals.

This is historical performance data from a Discord alert channel, not a
verified brokerage record. It's for information only, not financial advice
— nothing here accounts for real-world slippage, missed fills, or timing
lag from copy-trading an alert after the fact.
