import { AppError, type Env } from "./env";
import { logActions } from "./log";

const COOKIE = "dash_session";
const SESSION_DAYS = 30;
const MAX_LOGIN_FAILURES = 10; // per IP, per 15 minutes

const enc = new TextEncoder();

function b64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// The signing key is derived from APP_PASSWORD, so changing the password logs out every device.
async function hmacKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(`dash-session-v1:${env.APP_PASSWORD}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function sign(env: Env, payload: string): Promise<string> {
  return b64url(await crypto.subtle.sign("HMAC", await hmacKey(env), enc.encode(payload)));
}

/** Constant-time string comparison (hash both sides so lengths match). */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export async function isAuthed(req: Request, env: Env): Promise<boolean> {
  if (!env.APP_PASSWORD) return false;
  const raw = readCookie(req, COOKIE);
  if (!raw) return false;
  const [exp, sig] = raw.split(".");
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
  return safeEqual(sig, await sign(env, exp));
}

export async function requireAuth(req: Request, env: Env): Promise<void> {
  if (!(await isAuthed(req, env))) throw new AppError("unauthorized", "Please log in.", 401);
}

/** Reject cross-site state-changing requests (belt and braces on top of SameSite=Lax). */
export function checkOrigin(req: Request): void {
  if (req.method === "GET" || req.method === "HEAD") return;
  const origin = req.headers.get("Origin");
  if (origin && origin !== new URL(req.url).origin) throw new AppError("bad_origin", "Cross-site request blocked.", 403);
}

function sessionCookie(value: string, maxAge: number): string {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export async function handleLogin(req: Request, env: Env): Promise<Response> {
  if (!env.APP_PASSWORD) throw new AppError("not_configured", "APP_PASSWORD secret isn't set on the Worker.", 500);

  const ip = req.headers.get("CF-Connecting-IP") ?? "local";
  const failKey = `login_fail:${ip}`;
  const failures = Number((await env.KV.get(failKey)) ?? 0);
  if (failures >= MAX_LOGIN_FAILURES) {
    throw new AppError("rate_limited", "Too many wrong tries. Take a breather and try again in 15 minutes.", 429);
  }

  const body = (await req.json().catch(() => ({}))) as { password?: string };
  if (!body.password || !(await safeEqual(body.password, env.APP_PASSWORD))) {
    await env.KV.put(failKey, String(failures + 1), { expirationTtl: 900 });
    await logActions(env, [{ kind: "login", text: `Wrong password entered (from ${ip})` }]);
    throw new AppError("bad_password", "Hmm, that's not the right password. Try again?", 401);
  }

  await logActions(env, [{ kind: "login", text: "Logged in" }]);
  const exp = String(Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400);
  const value = `${exp}.${await sign(env, exp)}`;
  return Response.json({ ok: true }, { headers: { "Set-Cookie": sessionCookie(value, SESSION_DAYS * 86400) } });
}

export function handleLogout(): Response {
  return Response.json({ ok: true }, { headers: { "Set-Cookie": sessionCookie("", 0) } });
}
