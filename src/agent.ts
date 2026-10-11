import Anthropic from "@anthropic-ai/sdk";
import type { CreatedItem, Env } from "./env";
import { logActions } from "./log";
import { appendHistory, getBatches, getHistory, pushBatch } from "./store";
import { addDays, formatOffset, nowLocal, prettyDate } from "./time";
import { TOOLS, ToolContext, runTool } from "./tools";
import { defaultList } from "./trello";
import { costUsd, recordUsage } from "./usage";

const MAX_STEPS = 8;

const INSTRUCTIONS = `You are a personal assistant inside a small phone app. The user types or speaks quick requests, and you add events to their Google Calendar and cards to their Trello boards using your tools.

How to work:
- Act, don't chat. When a request is clear, call the tools straight away. One message can need several tool calls (e.g. an event plus a reminder card); make all of them.
- Events vs cards: things that happen at a time (appointments, meetings, lunches, classes) go on the calendar. Things to do (tasks, "remind me to…", assignments, errands) become Trello cards.
- Dates: resolve relative dates ("tomorrow", "Friday", "in 2 weeks") against the current local date and time given below. "Friday"/"this Friday" means the next upcoming Friday. "Next Friday" means the Friday of next week (weeks run Monday to Sunday). Use the date table below rather than doing weekday arithmetic yourself.
- Times are local wall-clock times. Pass them exactly as 'YYYY-MM-DDTHH:MM' with no offset. Read "3" or "3pm" in normal waking hours sensibly (lunch at 1 = 13:00).
- Calendar events need a time unless the user clearly means an all-day thing (birthdays, holidays, "all day", multi-day trips). If an appointment-like event has no time, ask.
- Trello cards: match the list the user names to the catalogue (fuzzy matching on names and course codes is fine, e.g. "EDUC1222" or "reading and comprehending"). If they don't name a list, omit list_id to use the default list. Only give a card a due date if the user gives one, and a due time only if they give a specific time.
- Ask a brief follow-up question instead of guessing when something important is missing or ambiguous: no time for an appointment, a list name that matches several lists or none. Ask one short question and create nothing until it's answered. Things that are clear in the same message can still be created.
- If you create some items and also need to ask about another, put the question in the same message as the tool calls.
- "Undo", "delete that", "scrap that": call delete_item (no ref undoes the last request's items; use a ref from 'Recently created' for a specific one).
- If a tool fails, say what failed in one plain sentence. If Google isn't connected, tell the user to tap "Connect Google".

Replies:
- Warm, friendly and upbeat, like a helpful friend, but short: one line per item. A light touch of personality is welcome ("Done!", "You're all set", "Easy."), but no gushing and at most one emoji.
- Plain text, no markdown headings, no bullet symbols, no links (the app shows cards with links under your reply).
- Confirm what you created with its day and date, e.g. "Done! Dentist is in for Thu 15 Oct, 3:00–4:00 pm." or "Added 'Renew rego' to Flinders › Miscellaneous ✓".
- For calendar questions, list events briefly with times. If the day is empty, say so nicely ("Nothing on tomorrow, enjoy!").
- Follow-up questions are friendly and quick, e.g. "Sure! What time is the dentist?"`;

function contextBlock(env: Env, catalogText: string, recent: CreatedItem[]): string {
  const tz = env.TIMEZONE;
  const now = nowLocal(tz);
  const days = Array.from({ length: 21 }, (_, i) => {
    const d = addDays(now.date, i);
    const label = i === 0 ? " (today)" : i === 1 ? " (tomorrow)" : "";
    return `${prettyDate(d)} ${d.slice(0, 4)} = ${d}${label}`;
  }).join("\n");

  const recentText = recent.length
    ? recent.map((i) => `ref ${i.ref}: ${i.kind} "${i.title}"${i.when ? `, ${i.when}` : ""}${i.where ? `, ${i.where}` : ""}`).join("\n")
    : "(nothing yet)";

  return `Current local date and time: ${prettyDate(now.date)} ${now.date.slice(0, 4)}, ${now.time} (${tz}, ${formatOffset(now.offsetMinutes)}).

Next three weeks:
${days}

${catalogText}

Recently created by you (newest last):
${recentText}`;
}

async function catalogText(ctx: ToolContext): Promise<string> {
  try {
    const catalog = await ctx.trello();
    const def = defaultList(ctx.env, catalog);
    const boards = catalog.boards
      .map(
        (b) =>
          `Board "${b.name}":\n` +
          b.lists.map((l) => `  - list "${l.name}" id=${l.id}`).join("\n") +
          (b.labels.some((l) => l.name) ? `\n  labels: ${b.labels.filter((l) => l.name).map((l) => l.name).join(", ")}` : ""),
      )
      .join("\n");
    return `Trello boards and lists:\n${boards}\nDefault list: ${def ? `"${def.list.name}" on board "${def.board.name}"` : "NOT FOUND (ask which list)"}`;
  } catch (e) {
    return `Trello boards and lists: unavailable (${(e as Error).message}). Don't create cards; tell the user Trello isn't reachable.`;
  }
}

const WRITE_TOOLS = new Set(["create_calendar_event", "create_trello_card", "delete_item"]);

/** Friendly one-line-per-item confirmation, built without calling the model. */
function confirmation(ctx: ToolContext): string {
  const lines = ctx.created.map((i) =>
    i.kind === "event"
      ? `Done! "${i.title}" is in for ${i.when}${i.where ? ` at ${i.where}` : ""}.`
      : `Added "${i.title}" to ${i.where}${i.when ? `, ${i.when}` : ""} ✓`,
  );
  for (const d of ctx.deleted) lines.push(`Removed the ${d.kind === "event" ? "event" : "card"} "${d.title}".`);
  return lines.join("\n") || "Done!";
}

export interface ChatResult {
  reply: string;
  items: CreatedItem[];
  deleted: CreatedItem[];
  needsGoogle: boolean;
}

export async function chat(env: Env, userText: string): Promise<ChatResult> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const ctx = new ToolContext(env);

  const [history, batches, catalog] = await Promise.all([getHistory(env), getBatches(env), catalogText(ctx)]);
  const recent = batches.flat().slice(-10);

  const messages: Anthropic.Beta.BetaMessageParam[] = [...history, { role: "user", content: userText }];
  let reply = "";
  const spend = { cost: 0, tokensIn: 0, tokensOut: 0 };

  const model = env.ANTHROPIC_MODEL || "claude-haiku-5-5";
  const effort = (["low", "medium", "high"].includes(env.ANTHROPIC_EFFORT) ? env.ANTHROPIC_EFFORT : "low") as "low" | "medium" | "high";
  // Server-side refusal fallback exists for Sonnet/Opus but not Haiku (sending it to Haiku is an error).
  const fallback = model.startsWith("claude-haiku") ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const };

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const response = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        // Stable instructions first (cacheable), then the per-request date/catalogue context.
        system: [
          { type: "text", text: INSTRUCTIONS, cache_control: { type: "ephemeral" } },
          { type: "text", text: contextBlock(env, catalog, recent) },
        ],
        tools: TOOLS,
        messages,
        output_config: { effort },
        ...fallback,
      });
      spend.cost += costUsd(response.model || model, response.usage);
      spend.tokensIn += response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0);
      spend.tokensOut += response.usage.output_tokens;

      if (response.stop_reason === "refusal") {
        reply = "Sorry, that's one I can't help with.";
        break;
      }

      messages.push({ role: "assistant", content: response.content });
      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();

      if (response.stop_reason !== "tool_use") {
        reply = text;
        break;
      }

      const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      let allClean = true; // every call was a create/delete that fully succeeded
      const results = await Promise.all(
        toolUses.map(async (tu, i): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
          try {
            const out = (await runTool(ctx, tu.name, (tu.input ?? {}) as Record<string, unknown>, step * 100 + i)) as Record<string, unknown>;
            if (!WRITE_TOOLS.has(tu.name) || out.ok !== true || out.labels_not_found) allClean = false;
            return { type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out) };
          } catch (e) {
            allClean = false;
            console.error(`tool ${tu.name} failed`, e);
            return { type: "tool_result", tool_use_id: tu.id, content: (e as Error).message, is_error: true };
          }
        }),
      );

      // Saves credits: when everything simply worked, write the confirmation here instead of
      // paying for a second model call just to say "Done!". Keep any question the model asked.
      if (allClean) {
        const question = /\?\s*$/.test(text) ? text : "";
        reply = [confirmation(ctx), question].filter(Boolean).join("\n");
        break;
      }
      messages.push({ role: "user", content: results });
    }
  } finally {
    // Count what this request cost even if something failed halfway.
    if (spend.tokensIn) await recordUsage(env, spend.cost, spend.tokensIn, spend.tokensOut).catch(() => {});
  }

  if (!reply) {
    reply = ctx.created.length
      ? `Done: ${ctx.created.map((i) => i.title).join(", ")}.`
      : ctx.needsGoogle
        ? "I'd love to, but Google Calendar isn't connected yet. Tap Connect Google and I'll sort it."
        : "Hmm, I couldn't quite finish that. Mind rephrasing?";
  }

  // Remember the exchange as plain text. Mention created items so follow-ups ("move it to 4pm") have context.
  const memo = ctx.created.length ? `\n[created: ${ctx.created.map((i) => `${i.kind} "${i.title}" ref ${i.ref}`).join("; ")}]` : "";
  await Promise.all([
    appendHistory(env, { role: "user", content: userText }, { role: "assistant", content: reply + memo }),
    pushBatch(env, ctx.created),
    logActions(env, [
      ...ctx.created.map((i) => ({
        kind: "created" as const,
        text: `Added ${i.kind === "event" ? "event" : "card"} "${i.title}"${i.when ? ` (${i.when})` : ""}${i.where ? ` · ${i.where}` : ""}`,
        url: i.url,
      })),
      ...ctx.deleted.map((i) => ({ kind: "deleted" as const, text: `Deleted ${i.kind === "event" ? "event" : "card"} "${i.title}"` })),
    ]),
  ]);

  return { reply, items: ctx.created, deleted: ctx.deleted, needsGoogle: ctx.needsGoogle };
}
