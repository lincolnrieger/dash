# Dash

A personal assistant that runs entirely on Cloudflare Workers. Type or speak a quick request on your phone, and it adds events to Google Calendar or cards to Trello.

```
"dentist next Thursday 3pm"
"add 'renew rego' to my EDUC1222 list"
"lunch with Sam Friday at 1, and remind me to book the restaurant"
"what's on tomorrow?"
"undo"
```

- **Brain:** Claude Sonnet 5.5 (`claude-sonnet-5-5`) with tool calling. Each request gets the current date and time in Australia/Adelaide, plus your Trello boards and lists.
- **Voice:** the browser records audio (MediaRecorder), and Workers AI Whisper transcribes it. The transcript appears in the chat before it's processed.
- **Storage:** one KV namespace holds the Google refresh token, the Trello board/list cache (1 hour), the undo log and the last 10 chat messages.
- **Auth:** a password login sets a signed, HttpOnly cookie that lasts 30 days. Every `/api/*` route checks it.

---

## Setup

You'll need [Node.js 20+](https://nodejs.org), a free [Cloudflare account](https://dash.cloudflare.com/sign-up), a Google account, a Trello account and an [Anthropic API key](https://console.anthropic.com/settings/keys).

### 1. Install and log in to Cloudflare

```bash
git clone https://github.com/lincolnrieger/dash.git
cd dash
npm install
npx wrangler login
```

### 2. Create the KV namespace

```bash
npx wrangler kv namespace create KV
```

Copy the `id` it prints into `wrangler.toml` (`[[kv_namespaces]]` → `id`). This repo is already set to the `dash-KV` namespace.

### 3. Deploy once to get your URL

```bash
npx wrangler deploy
```

Wrangler prints your URL, something like `https://dash.<your-subdomain>.workers.dev`. You need it for the Google redirect URI. The app won't work yet because the secrets aren't set.

### 4. Google Cloud project and OAuth credentials

1. Go to <https://console.cloud.google.com/> and create a project (for example "Dash").
2. **Enable the Calendar API:** APIs & Services → Library → search "Google Calendar API" → **Enable**.
3. **Configure the consent screen:** APIs & Services → OAuth consent screen (called "Google Auth Platform" in the newer console).
   - User type: **External**. App name: "Dash". Fill in your email for the support and developer contacts.
   - **Data access / Scopes:** add `https://www.googleapis.com/auth/calendar.events`.
   - **Audience / Test users:** add your own Google address.
   - **Publish the app** (Audience → Publishing status → *Publish app* / "In production"). While an app is in *Testing*, Google expires refresh tokens after 7 days, so you'd have to reconnect every week. You don't need Google's verification for personal use. When you connect, you'll see "Google hasn't verified this app": tap **Advanced → Go to Dash (unsafe)**. That's expected for your own app.
4. **Create credentials:** APIs & Services → Credentials → **Create credentials → OAuth client ID**.
   - Application type: **Web application**.
   - **Authorized redirect URIs:** add
     - `https://dash.<your-subdomain>.workers.dev/auth/google/callback`
     - `http://localhost:8787/auth/google/callback` (optional, for local dev)
   - Save, then copy the **Client ID** and **Client secret**.

### 5. Trello key and token

1. Open <https://trello.com/power-ups/admin> → **New** to create an integration. Any name and workspace will do; the iframe connector URL can be left blank. Open it and go to **API key** → **Generate a new API key**. Copy the **API key**.
2. Get a token by opening this URL with your key in it, then click **Allow**:

   ```
   https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=Dash&key=YOUR_API_KEY
   ```

   Copy the token it shows.

### 6. Set the secrets

Run each command and paste the value when prompted:

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put TRELLO_API_KEY
npx wrangler secret put TRELLO_TOKEN
npx wrangler secret put APP_PASSWORD      # pick a long password; changing it logs out every device
```

### 7. Deploy

```bash
npx wrangler deploy
```

Open your `workers.dev` URL, log in with `APP_PASSWORD`, then tap **"Google isn't connected. Tap here to connect"** and approve. The header pills turn green when Calendar and Trello are both working.

### 8. Add it to your phone's home screen

**iPhone (Safari):**
1. Open the URL in **Safari** (not Chrome) and log in.
2. Tap **Share** (the square with an arrow) → **Add to Home Screen** → **Add**.
3. Open Dash from the home screen. The first time you tap the mic, allow microphone access.

**Android (Chrome):**
1. Open the URL in Chrome and log in.
2. Tap **⋮** → **Install app** (or **Add to Home screen**) → **Install**.
3. Allow the microphone when asked.

You stay logged in for 30 days.

---

## Configuration

Non-secret settings live in `[vars]` in `wrangler.toml`. Run `npx wrangler deploy` after changing them.

| Var | Default | What it does |
| --- | --- | --- |
| `TIMEZONE` | `Australia/Adelaide` | All relative dates resolve here, and the current local time is sent with every request. |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | The Claude model used. |
| `GOOGLE_CALENDAR_ID` | `primary` | Calendar that events go into. |
| `TRELLO_DEFAULT_BOARD` | `Flinders` | Board holding the default list. |
| `TRELLO_DEFAULT_LIST` | `Miscellaneous` | Where cards go when you don't name a list. To use a "To Do" list, change this (and the board). |
| `TRELLO_ALL_DAY_DUE_TIME` | `23:59` | Due time used when you give a card a date but no time. |

Trello boards and lists are cached for an hour. If you add a list and want it straight away, use **⋯ → Refresh Trello lists**.

## How it behaves

- **Several items per message.** "Lunch with Sam Friday at 1, and remind me to book the restaurant" creates a calendar event *and* a Trello card.
- **Ambiguity:** if an appointment has no time, or a list name matches several lists or none, it asks a short follow-up question instead of guessing.
- **Defaults:** events last 1 hour unless you give an end time. Things like birthdays become all-day events. Cards only get a due date if you say one, and a due time only if you give a specific time.
- **Undo:** typing or saying "undo", or tapping **Undo** under a reply, deletes everything the last message created. Repeat it to go further back (up to 10 messages). You can also say "delete the dentist one".
- **Questions:** "what's on tomorrow?" or "am I free Friday afternoon?" read your calendar.
- If Claude declines a request on safety grounds, the API automatically retries it on a fallback model. This uses the `server-side-fallback-2026-07-01` beta with `fallbacks: "default"`; remove those two lines in `src/agent.ts` if you don't want it.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in real values
npm run dev                      # http://localhost:8787
npm test                         # agent/tool tests with mocked Anthropic, Google and Trello
npm run typecheck
```

`wrangler dev` runs the Workers AI binding remotely, so you need `npx wrangler login` first. Voice transcription in local dev uses your Cloudflare account. To connect Google locally, add the localhost redirect URI from step 4.

## Project layout

```
wrangler.toml        Worker config: KV + AI bindings, static assets, vars
src/index.ts         Router: /api/*, /auth/google*, static assets, friendly errors
src/auth.ts          Password login, HMAC-signed session cookie, origin check, login rate limit
src/agent.ts         System prompt (date, Trello catalogue, recent items) + Claude tool loop
src/tools.ts         Tool schemas and implementations, undo
src/google.ts        Google OAuth (offline access), token refresh, Calendar API
src/trello.ts        Trello boards/lists/labels (cached in KV), create/delete cards
src/store.ts         KV chat history (last 10) and undo log
src/time.ts          Timezone helpers (Intl-based, DST-aware)
public/              Chat UI (plain HTML/CSS/JS), PWA manifest, service worker, icons
test/                End-to-end tests with mocked APIs
```

## Troubleshooting

| Problem | Fix |
| --- | --- |
| "Google isn't connected" keeps coming back | The OAuth app is still in *Testing* (tokens expire after 7 days). Publish it (step 4.3) and reconnect. |
| `redirect_uri_mismatch` from Google | The redirect URI in Google Cloud must exactly match `https://<your-url>/auth/google/callback`. |
| Trello pill is red | Check `TRELLO_API_KEY` / `TRELLO_TOKEN`. Hover or long-press the pill to see the error. |
| "The Anthropic API key is invalid" | Re-run `npx wrangler secret put ANTHROPIC_API_KEY`. |
| Mic does nothing on iPhone | Open Dash from Safari or the home-screen icon (not an in-app browser), and allow the microphone in Settings → Safari → Microphone. |
| Voice transcripts are empty on iPhone | Safari records `audio/mp4`. If Whisper struggles with it, switch the model in `src/index.ts` to `@cf/openai/whisper-large-v3-turbo` (it takes base64 audio: `{ audio: base64String }`). |
| Locked out after wrong passwords | Ten failures from one IP block logins for 15 minutes. |
