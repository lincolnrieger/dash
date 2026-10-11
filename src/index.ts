import Anthropic from "@anthropic-ai/sdk";
import { chat } from "./agent";
import { checkOrigin, handleLogin, handleLogout, isAuthed, requireAuth } from "./auth";
import { AppError, type Env } from "./env";
import { disconnectGoogle, finishGoogleAuth, isGoogleConnected, startGoogleAuth } from "./google";
import { clearHistory, getHistory } from "./store";
import { undo } from "./tools";
import { defaultList, getCatalog } from "./trello";

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const UNDO_RE = /^\s*(undo|undo (that|it|last|the last one))\s*[.!]*\s*$/i;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (e) {
      return errorResponse(e);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const { pathname: path } = url;
  const method = req.method;

  // ----- Google OAuth (browser navigations, so redirect instead of returning JSON errors) -----
  if (path === "/auth/google" || path === "/auth/google/callback") {
    if (!(await isAuthed(req, env))) return Response.redirect(`${url.origin}/`, 302);
    return path === "/auth/google" ? startGoogleAuth(req, env) : finishGoogleAuth(req, env);
  }

  if (!path.startsWith("/api/")) return env.ASSETS.fetch(req);

  checkOrigin(req);
  const json = (data: unknown, status = 200) =>
    Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

  // ----- Public API -----
  if (path === "/api/login" && method === "POST") return handleLogin(req, env);
  if (path === "/api/logout" && method === "POST") return handleLogout();

  // ----- Everything below needs a session -----
  await requireAuth(req, env);

  if (path === "/api/status" && method === "GET") {
    const [google, trello] = await Promise.all([
      isGoogleConnected(env),
      getCatalog(env)
        .then((c) => {
          const d = defaultList(env, c);
          return { ok: true, defaultList: d ? `${d.board.name} › ${d.list.name}` : null };
        })
        .catch((e: Error) => ({ ok: false, error: e.message })),
    ]);
    return json({ google, trello, timezone: env.TIMEZONE });
  }

  if (path === "/api/history" && method === "GET") {
    const history = await getHistory(env);
    // Strip the internal "[created: …]" memo before showing it.
    return json(history.map((t) => ({ role: t.role, content: t.content.replace(/\n\[created: .*\]$/s, "") })));
  }

  if (path === "/api/history" && method === "DELETE") {
    await clearHistory(env);
    return json({ ok: true });
  }

  if (path === "/api/chat" && method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { message?: string };
    const message = body.message?.trim();
    if (!message) throw new AppError("empty", "Type or say something first.");
    if (message.length > 4000) throw new AppError("too_long", "That message is too long.");
    if (UNDO_RE.test(message)) return json(await undoResponse(env));
    if (!env.ANTHROPIC_API_KEY) throw new AppError("not_configured", "ANTHROPIC_API_KEY secret isn't set.", 500);
    return json(await chat(env, message));
  }

  if (path === "/api/undo" && method === "POST") return json(await undoResponse(env));

  if (path === "/api/transcribe" && method === "POST") {
    if (!env.AI) throw new AppError("not_configured", "Voice needs the Workers AI binding (see wrangler.toml).", 500);
    const audio = await req.arrayBuffer();
    if (audio.byteLength < 1000) throw new AppError("no_audio", "I didn't catch any audio. Try holding the mic a bit longer.");
    if (audio.byteLength > MAX_AUDIO_BYTES) throw new AppError("too_long", "That recording is too long. Keep it under a minute or so.");
    const result = (await env.AI.run("@cf/openai/whisper", { audio: [...new Uint8Array(audio)] })) as { text?: string };
    const text = (result.text ?? "").trim();
    if (!text) throw new AppError("no_speech", "I couldn't hear any words. Try again?");
    return json({ text });
  }

  if (path === "/api/google/disconnect" && method === "POST") {
    await disconnectGoogle(env);
    return json({ ok: true });
  }

  if (path === "/api/trello/refresh" && method === "POST") {
    const c = await getCatalog(env, { fresh: true });
    return json({ boards: c.boards.map((b) => ({ name: b.name, lists: b.lists.map((l) => l.name) })) });
  }

  throw new AppError("not_found", "Not found.", 404);
}

async function undoResponse(env: Env) {
  const r = await undo(env);
  let reply: string;
  if (r.nothing) reply = "There's nothing to undo.";
  else if (!r.deleted.length) reply = `Couldn't undo: ${r.failed.join("; ")}`;
  else {
    reply = `Undone: removed ${r.deleted.map((d) => `${d.kind === "event" ? "event" : "card"} "${d.title}"`).join(", ")}.`;
    if (r.failed.length) reply += ` Couldn't remove: ${r.failed.join("; ")}`;
  }
  return { reply, items: [], deleted: r.deleted, needsGoogle: false };
}

function errorResponse(e: unknown): Response {
  let code = "server_error";
  let message = "Something went wrong. Try again in a moment.";
  let status = 500;

  if (e instanceof AppError) {
    ({ code, message, status } = e);
  } else if (e instanceof Anthropic.APIError) {
    code = "ai_error";
    status = 502;
    if (e.status === 401) message = "The Anthropic API key is invalid. Check the ANTHROPIC_API_KEY secret.";
    else if (e.status === 429 || e.status === 529) message = "The AI is busy right now. Try again in a few seconds.";
    else if (e.status === 400) message = `The AI request was rejected: ${e.message}`;
    else message = "Couldn't reach the AI. Try again in a moment.";
    console.error("Anthropic error", e.status, e.message);
  } else {
    console.error(e);
  }
  if (e instanceof AppError && e.code === "google_not_connected") {
    message = "Google isn't connected. Tap here to connect.";
  }
  return Response.json({ error: code, message }, { status, headers: { "Cache-Control": "no-store" } });
}
