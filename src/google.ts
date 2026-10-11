import { AppError, type Env } from "./env";

const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const REFRESH_KEY = "google:refresh_token";
const ACCESS_KEY = "google:access_token";
const API = "https://www.googleapis.com/calendar/v3";

const notConnected = () =>
  new AppError("google_not_connected", "Google Calendar isn't connected yet.", 400);

function redirectUri(req: Request): string {
  return `${new URL(req.url).origin}/auth/google/callback`;
}

// ---------- OAuth flow ----------

export async function startGoogleAuth(req: Request, env: Env): Promise<Response> {
  if (!env.GOOGLE_CLIENT_ID) throw new AppError("not_configured", "GOOGLE_CLIENT_ID secret isn't set.", 500);
  const state = crypto.randomUUID();
  await env.KV.put(`oauth_state:${state}`, "1", { expirationTtl: 600 });
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent", // always return a refresh token, even on re-connect
    include_granted_scopes: "true",
    state,
  });
  return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, 302);
}

export async function finishGoogleAuth(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const back = (status: string) => Response.redirect(`${url.origin}/?google=${status}`, 302);

  if (url.searchParams.get("error")) return back("denied");
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code");
  if (!code || !(await env.KV.get(`oauth_state:${state}`))) return back("bad_state");
  await env.KV.delete(`oauth_state:${state}`);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(req),
      grant_type: "authorization_code",
    }),
  });
  const data = (await res.json()) as { refresh_token?: string; access_token?: string; expires_in?: number };
  if (!res.ok || !data.refresh_token) {
    console.error("Google token exchange failed", res.status, data);
    return back("failed");
  }
  await env.KV.put(REFRESH_KEY, data.refresh_token);
  if (data.access_token) await cacheAccessToken(env, data.access_token, data.expires_in ?? 3600);
  return back("connected");
}

export async function isGoogleConnected(env: Env): Promise<boolean> {
  return (await env.KV.get(REFRESH_KEY)) !== null;
}

export async function disconnectGoogle(env: Env): Promise<void> {
  await Promise.all([env.KV.delete(REFRESH_KEY), env.KV.delete(ACCESS_KEY)]);
}

async function cacheAccessToken(env: Env, token: string, expiresIn: number) {
  // Expire a few minutes early so we never use a token that's about to die. KV's minimum TTL is 60s.
  await env.KV.put(ACCESS_KEY, token, { expirationTtl: Math.max(60, expiresIn - 300) });
}

async function accessToken(env: Env): Promise<string> {
  const cached = await env.KV.get(ACCESS_KEY);
  if (cached) return cached;

  const refresh = await env.KV.get(REFRESH_KEY);
  if (!refresh) throw notConnected();

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
  });
  const data = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !data.access_token) {
    if (data.error === "invalid_grant") {
      // Refresh token revoked or expired: forget it so the UI offers to reconnect.
      await disconnectGoogle(env);
      throw notConnected();
    }
    throw new AppError("google_error", `Couldn't refresh the Google token (${data.error ?? res.status}).`, 502);
  }
  await cacheAccessToken(env, data.access_token, data.expires_in ?? 3600);
  return data.access_token;
}

async function gcal<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const token = await accessToken(env);
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
  }).catch(() => {
    throw new AppError("google_error", "Couldn't reach Google Calendar. Try again in a moment.", 502);
  });
  if (res.status === 401) {
    await env.KV.delete(ACCESS_KEY); // next call will refresh
    throw new AppError("google_error", "Google rejected the access token. Try again.", 502);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new AppError("google_error", `Google Calendar error ${res.status}: ${text.slice(0, 300)}`, 502);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

// ---------- Calendar API ----------

type EventTime = { date: string } | { dateTime: string; timeZone: string };

export interface GEvent {
  id: string;
  htmlLink: string;
  summary?: string;
  location?: string;
  start: { date?: string; dateTime?: string };
  end: { date?: string; dateTime?: string };
}

export async function createEvent(
  env: Env,
  calendarId: string,
  ev: { summary: string; start: EventTime; end: EventTime; location?: string; description?: string },
): Promise<GEvent> {
  return gcal<GEvent>(env, `/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: "POST",
    body: JSON.stringify(ev),
  });
}

export async function listEvents(
  env: Env,
  calendarId: string,
  timeMin: string,
  timeMax: string,
  maxResults: number,
): Promise<GEvent[]> {
  const q = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(maxResults),
    timeZone: env.TIMEZONE,
  });
  const data = await gcal<{ items: GEvent[] }>(env, `/calendars/${encodeURIComponent(calendarId)}/events?${q}`);
  return data.items ?? [];
}

export async function deleteEvent(env: Env, calendarId: string, eventId: string): Promise<void> {
  try {
    await gcal(env, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
      method: "DELETE",
    });
  } catch (e) {
    // Already deleted (404 Not Found / 410 Gone) counts as success.
    if (e instanceof AppError && / (404|410):/.test(e.message)) return;
    throw e;
  }
}
