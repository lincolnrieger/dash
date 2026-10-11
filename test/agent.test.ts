// End-to-end test of the chat → tools → undo flow with Anthropic, Google and Trello mocked at the fetch layer.
// Run with `npm test` (bundles this file with esbuild and runs it in Node).
import assert from "node:assert/strict";
import { chat } from "../src/agent";
import type { Env } from "../src/env";
import { getBatches, getHistory } from "../src/store";
import { undo } from "../src/tools";
import { getLog } from "../src/log";
import { costUsd, setCredit, usageSummary } from "../src/usage";
import { addDays, localToUtc, nowLocal, prettyLocal, tzOffsetMinutes } from "../src/time";

// ---------- in-memory KV ----------
class MemKV {
  m = new Map<string, string>();
  async get(k: string, type?: string) {
    const v = this.m.get(k);
    if (v === undefined) return null;
    return type === "json" ? JSON.parse(v) : v;
  }
  async put(k: string, v: string) {
    this.m.set(k, v);
  }
  async delete(k: string) {
    this.m.delete(k);
  }
}

const kv = new MemKV();
kv.m.set("google:refresh_token", "rt"); // pretend Google is already connected
const env = {
  KV: kv,
  TIMEZONE: "Australia/Adelaide",
  ANTHROPIC_MODEL: "claude-haiku-5-5",
  ANTHROPIC_EFFORT: "low",
  GOOGLE_CALENDAR_ID: "primary",
  TRELLO_DEFAULT_BOARD: "Flinders",
  TRELLO_DEFAULT_LIST: "Miscellaneous",
  TRELLO_ALL_DAY_DUE_TIME: "23:59",
  ANTHROPIC_API_KEY: "sk-test",
  GOOGLE_CLIENT_ID: "cid",
  GOOGLE_CLIENT_SECRET: "secret",
  TRELLO_API_KEY: "tk",
  TRELLO_TOKEN: "tt",
  APP_PASSWORD: "pw",
} as unknown as Env;

// ---------- fetch mock ----------
type Call = { method: string; url: string; body: any; headers: Record<string, string> };
const calls: Call[] = [];
let anthropicScript: any[] = [];
let googleEvents: any[] = [];
let googleConnected = true;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const req = new Request(input as any, init);
  const url = new URL(req.url);
  const text = req.method === "GET" || req.method === "DELETE" ? "" : await req.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {}
  calls.push({ method: req.method, url: req.url, body, headers: Object.fromEntries(req.headers) });

  if (url.host === "api.anthropic.com") {
    const next = anthropicScript.shift();
    assert.ok(next, "unexpected extra Anthropic call");
    return json({ id: "msg_1", type: "message", role: "assistant", model: body.model, usage: { input_tokens: 1, output_tokens: 1 }, ...next });
  }
  if (url.host === "oauth2.googleapis.com") {
    return googleConnected ? json({ access_token: "at", expires_in: 3600 }) : json({ error: "invalid_grant" }, 400);
  }
  if (url.host === "www.googleapis.com") {
    if (req.method === "POST") {
      const ev = { id: `ev${googleEvents.length + 1}`, htmlLink: "https://calendar.google.com/event?eid=x", ...body };
      googleEvents.push(ev);
      return json(ev);
    }
    if (req.method === "DELETE") return new Response(null, { status: 204 });
    return json({ items: [{ summary: "Tutorial", start: { dateTime: "2026-10-12T09:00:00+10:30" }, end: { dateTime: "2026-10-12T10:00:00+10:30" } }] });
  }
  if (url.host === "api.trello.com") {
    if (url.pathname === "/1/members/me/boards") {
      return json([
        { id: "b1", name: "Flinders", url: "https://trello.com/b/KnjFWKwR/flinders", lists: [
          { id: "l1", name: "EDUC1222 - Reading, Comprehending and Producing Texts" },
          { id: "l5", name: "Miscellaneous" },
        ] },
        { id: "b2", name: "Personal", url: "https://trello.com/b/x/personal", lists: [{ id: "p1", name: "To Do" }] },
      ]);
    }
    if (url.pathname.endsWith("/labels")) return json([{ id: "lab1", name: "Urgent", color: "red" }]);
    if (url.pathname === "/1/cards" && req.method === "POST") {
      return json({ id: "card1", name: url.searchParams.get("name"), shortUrl: "https://trello.com/c/abc", due: url.searchParams.get("due") });
    }
    if (url.pathname.startsWith("/1/cards/") && req.method === "DELETE") return json({});
  }
  throw new Error(`unmocked fetch ${req.method} ${req.url}`);
}) as typeof fetch;

const toolUse = (id: string, name: string, input: object) => ({ type: "tool_use", id, name, input });
const text = (t: string) => ({ type: "text", text: t });

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    console.error(`✗ ${name}\n`, e);
    process.exitCode = 1;
  }
}

// ---------- tests ----------

await test("time helpers handle Adelaide offsets and DST", async () => {
  // ACST (+9:30) in winter, ACDT (+10:30) in summer.
  assert.equal(tzOffsetMinutes(new Date("2026-07-01T00:00:00Z"), "Australia/Adelaide"), 570);
  assert.equal(tzOffsetMinutes(new Date("2026-12-01T00:00:00Z"), "Australia/Adelaide"), 630);
  assert.equal(localToUtc("2026-10-15T15:00", "Australia/Adelaide").toISOString(), "2026-10-15T04:30:00.000Z");
  assert.equal(localToUtc("2026-06-15T15:00", "Australia/Adelaide").toISOString(), "2026-06-15T05:30:00.000Z");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(prettyLocal("2026-10-15T15:00"), "Thu 15 Oct, 3:00 pm");
  const n = nowLocal("Australia/Adelaide", new Date("2026-10-11T01:00:00Z"));
  assert.deepEqual([n.date, n.time], ["2026-10-11", "11:30"]);
});

await test("one message creates an event and a card; system prompt carries date + catalogue", async () => {
  anthropicScript = [
    {
      stop_reason: "tool_use",
      content: [
        text("On it."),
        toolUse("t1", "create_calendar_event", { title: "Lunch with Sam", start: "2026-10-16T13:00", location: "Peel St" }),
        toolUse("t2", "create_trello_card", { title: "Book the restaurant", due: "2026-10-14", labels: ["urgent", "nope"] }),
      ],
    },
    { stop_reason: "end_turn", content: [text("Added Lunch with Sam, Fri 16 Oct 1:00–2:00 pm, and a card to book the restaurant.")] },
  ];
  const res = await chat(env, "lunch with Sam Friday at 1 at Peel St, and remind me to book the restaurant by Wednesday");
  assert.equal(res.items[0].when, "Fri 16 Oct, 1:00 pm – 2:00 pm");

  assert.equal(res.items.length, 2);
  assert.match(res.reply, /Lunch with Sam/);

  const first = calls.find((c) => c.url.includes("api.anthropic.com"))!;
  assert.equal(first.body.model, "claude-haiku-5-5");
  assert.deepEqual(first.body.output_config, { effort: "low" });
  assert.equal(first.body.fallbacks, undefined, "Haiku has no server-side fallback");
  assert.doesNotMatch(first.headers["anthropic-beta"] ?? "", /server-side-fallback/);
  const sys = first.body.system.map((b: any) => b.text).join("\n");
  assert.match(sys, /Current local date and time: .* \(Australia\/Adelaide, UTC\+10:30\)/);
  assert.match(sys, /list "Miscellaneous" id=l5/);
  assert.match(sys, /Default list: "Miscellaneous" on board "Flinders"/);

  // A label wasn't found, so the model gets a second call (with both tool results in one message) to explain.
  const second = calls.filter((c) => c.url.includes("api.anthropic.com"))[1];
  const lastMsg = second.body.messages.at(-1);
  assert.equal(lastMsg.role, "user");
  assert.deepEqual(lastMsg.content.map((b: any) => b.tool_use_id), ["t1", "t2"]);

  const ev = googleEvents[0];
  assert.deepEqual(ev.start, { dateTime: "2026-10-16T13:00:00", timeZone: "Australia/Adelaide" });
  assert.deepEqual(ev.end, { dateTime: "2026-10-16T14:00:00", timeZone: "Australia/Adelaide" }, "defaults to 1 hour");
  assert.equal(ev.location, "Peel St");

  const cardCall = calls.find((c) => c.url.includes("api.trello.com/1/cards") && c.method === "POST")!;
  const cardUrl = new URL(cardCall.url);
  assert.equal(cardUrl.searchParams.get("idList"), "l5", "default list");
  assert.equal(cardUrl.searchParams.get("due"), "2026-10-14T13:29:00.000Z", "date-only due → 23:59 Adelaide");
  assert.equal(cardUrl.searchParams.get("idLabels"), "lab1");

  const card = res.items.find((i) => i.kind === "card")!;
  assert.equal(card.where, "Flinders › Miscellaneous");
  assert.equal(card.url, "https://trello.com/c/abc");

  const batches = await getBatches(env);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 2);
  const history = await getHistory(env);
  assert.equal(history.length, 2);
  assert.equal(history[0].role, "user");
});

await test("all-day event uses exclusive end date", async () => {
  anthropicScript = [
    { stop_reason: "tool_use", content: [toolUse("t1", "create_calendar_event", { title: "Mum's birthday", start: "2026-11-02" })] },
    { stop_reason: "end_turn", content: [text("Added Mum's birthday, Mon 2 Nov (all day).")] },
  ];
  const before = calls.filter((c) => c.url.includes("api.anthropic.com")).length;
  const res = await chat(env, "mum's birthday 2 Nov");
  // Clean success → confirmation written locally, no second (paid) model call.
  assert.equal(calls.filter((c) => c.url.includes("api.anthropic.com")).length, before + 1);
  assert.equal(res.reply, 'Done! "Mum\'s birthday" is in for Mon 2 Nov (all day).');
  const ev = googleEvents.at(-1);
  assert.deepEqual(ev.start, { date: "2026-11-02" });
  assert.deepEqual(ev.end, { date: "2026-11-03" });
  assert.equal(res.items[0].when, "Mon 2 Nov (all day)");
});

await test("timed event without a time is rejected back to the model", async () => {
  anthropicScript = [
    { stop_reason: "tool_use", content: [toolUse("t1", "create_calendar_event", { title: "Dentist", start: "2026-10-15", all_day: false })] },
    { stop_reason: "end_turn", content: [text("What time is the dentist?")] },
  ];
  const before = googleEvents.length;
  const res = await chat(env, "dentist thursday");
  assert.equal(googleEvents.length, before);
  assert.equal(res.items.length, 0);
  const last = calls.filter((c) => c.url.includes("api.anthropic.com")).at(-1)!;
  const result = last.body.messages.at(-1).content[0];
  assert.equal(result.is_error, true);
  assert.match(result.content, /needs a start time/);
});

await test("undo removes the most recent batch only", async () => {
  // Batches so far: [lunch+card], [birthday]. Undo should remove the birthday.
  const r = await undo(env);
  assert.deepEqual(r.deleted.map((d) => d.title), ["Mum's birthday"]);
  const r2 = await undo(env);
  assert.deepEqual(r2.deleted.map((d) => d.title).sort(), ["Book the restaurant", "Lunch with Sam"]);
  const deletes = calls.filter((c) => c.method === "DELETE");
  assert.ok(deletes.some((c) => c.url.includes("api.trello.com/1/cards/card1")));
  assert.ok(deletes.some((c) => c.url.includes("/events/ev1")));
  const r3 = await undo(env);
  assert.equal(r3.nothing, true);
});

await test("delete_item tool deletes a specific item by ref", async () => {
  anthropicScript = [
    { stop_reason: "tool_use", content: [toolUse("t1", "create_trello_card", { title: "Renew rego", list_id: "p1" })] },
    { stop_reason: "end_turn", content: [text("Added 'Renew rego' to Personal › To Do.")] },
  ];
  const created = await chat(env, "add renew rego to my to do list");
  assert.equal(created.items[0].where, "Personal › To Do");
  const ref = created.items[0].ref;

  anthropicScript = [
    { stop_reason: "tool_use", content: [toolUse("t1", "delete_item", { ref })] },
    { stop_reason: "end_turn", content: [text("Deleted 'Renew rego'.")] },
  ];
  const del = await chat(env, "actually delete the rego card");
  assert.deepEqual(del.deleted.map((d) => d.ref), [ref]);
  assert.equal((await getBatches(env)).flat().length, 0);
});

await test("list_upcoming_events returns local times", async () => {
  anthropicScript = [
    { stop_reason: "tool_use", content: [toolUse("t1", "list_upcoming_events", { start_date: "2026-10-12", end_date: "2026-10-12" })] },
    { stop_reason: "end_turn", content: [text("Tomorrow: Tutorial 9–10 am.")] },
  ];
  await chat(env, "what's on tomorrow?");
  const list = calls.filter((c) => c.url.includes("www.googleapis.com") && c.method === "GET").at(-1)!;
  const u = new URL(list.url);
  assert.equal(u.searchParams.get("timeMin"), "2026-10-11T13:30:00.000Z");
  assert.equal(u.searchParams.get("timeMax"), "2026-10-12T13:30:00.000Z");
  const last = calls.filter((c) => c.url.includes("api.anthropic.com")).at(-1)!;
  const out = JSON.parse(last.body.messages.at(-1).content[0].content);
  assert.equal(out.events[0].start, "Mon 12 Oct, 9:00 am");
});

await test("revoked Google token flags needsGoogle and clears the stored token", async () => {
  await kv.put("google:refresh_token", "rt");
  await kv.delete("google:access_token");
  googleConnected = false;
  anthropicScript = [
    { stop_reason: "tool_use", content: [toolUse("t1", "create_calendar_event", { title: "Gym", start: "2026-10-13T07:00" })] },
    { stop_reason: "end_turn", content: [text("Google Calendar isn't connected. Tap Connect Google.")] },
  ];
  const res = await chat(env, "gym tuesday 7am");
  assert.equal(res.needsGoogle, true);
  assert.equal(await kv.get("google:refresh_token"), null);
  googleConnected = true;
});

await test("Sonnet requests opt into the server-side refusal fallback", async () => {
  const sonnetEnv = { ...env, ANTHROPIC_MODEL: "claude-sonnet-5-5", ANTHROPIC_EFFORT: "medium" } as Env;
  anthropicScript = [{ stop_reason: "end_turn", content: [text("Nothing on Monday.")] }];
  await chat(sonnetEnv, "anything monday?");
  const last = calls.filter((c) => c.url.includes("api.anthropic.com")).at(-1)!;
  assert.equal(last.body.model, "claude-sonnet-5-5");
  assert.equal(last.body.fallbacks, "default");
  assert.match(last.headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
  assert.deepEqual(last.body.output_config, { effort: "medium" });
});

await test("a follow-up question asked alongside tool calls is kept", async () => {
  anthropicScript = [
    {
      stop_reason: "tool_use",
      content: [text("Sure! And what time is the dentist?"), toolUse("t1", "create_trello_card", { title: "Buy milk" })],
    },
  ];
  const res = await chat(env, "buy milk, and dentist thursday");
  assert.equal(res.reply, 'Added "Buy milk" to Flinders › Miscellaneous ✓\nSure! And what time is the dentist?');
  await undo(env);
});

await test("cost maths matches Haiku and Sonnet prices", async () => {
  // 1M input + 1M output tokens
  assert.equal(costUsd("claude-haiku-5-5", { input_tokens: 1e6, output_tokens: 1e6 }), 0.6);
  assert.equal(costUsd("claude-sonnet-5-5", { input_tokens: 1e6, output_tokens: 1e6 }), 12);
  // cache reads are 10% of input price, writes 125%
  assert.equal(costUsd("claude-haiku-5-5", { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1e6 }), 0.01);
  assert.equal(costUsd("claude-haiku-5-5", { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1e6 }), 0.125);
});

await test("usage totals and credit countdown", async () => {
  const before = await usageSummary(env);
  assert.ok(before.allTime.requests >= 6, "every chat so far was counted");
  assert.ok(before.today.requests >= 1);
  await setCredit(env, 5);
  anthropicScript = [{ stop_reason: "end_turn", content: [text("Nothing on.")], usage: { input_tokens: 4000, output_tokens: 1000 } }];
  await chat(env, "anything on sunday?");
  const after = await usageSummary(env);
  const expected = (4000 * 0.1 + 1000 * 0.5) / 1e6;
  assert.ok(Math.abs(after.allTime.cost - before.allTime.cost - expected) < 1e-12);
  assert.ok(Math.abs(after.credit!.remaining - (5 - expected)) < 1e-12);
  await setCredit(env, null);
  assert.equal((await usageSummary(env)).credit, null);
});

await test("activity log records creates and deletes, newest first", async () => {
  const log = await getLog(env);
  assert.ok(log.length >= 4);
  assert.ok(log.some((e) => e.kind === "created" && e.text.includes('"Lunch with Sam"') && e.url));
  assert.ok(log.some((e) => e.kind === "deleted" && e.text.includes("Renew rego")));
  assert.ok(log[0].at >= log.at(-1)!.at);
});

await test("history is capped at 10 messages and starts with a user turn", async () => {
  const history = await getHistory(env);
  assert.ok(history.length <= 10);
  assert.equal(history[0].role, "user");
});
