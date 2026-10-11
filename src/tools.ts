import type Anthropic from "@anthropic-ai/sdk";
import { AppError, type CreatedItem, type Env } from "./env";
import { createEvent, deleteEvent, listEvents } from "./google";
import { forgetItems, getBatches, newRef } from "./store";
import {
  addDays,
  addMinutesLocal,
  isDateOnly,
  localToUtc,
  nowLocal,
  parseLocal,
  prettyDate,
  prettyLocal,
  prettyTime,
  utcToLocal,
} from "./time";
import { createCard, defaultList, deleteCard, findList, getCatalog, type TrelloCatalog } from "./trello";

export const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "create_calendar_event",
    description:
      "Create an event in the user's Google Calendar. Use for appointments, meetings, social plans and anything happening at a specific time. Times are local wall-clock times in the user's timezone; never add a UTC offset.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short event title, e.g. 'Dentist' or 'Lunch with Sam'." },
        start: {
          type: "string",
          description: "Local start: 'YYYY-MM-DDTHH:MM' for a timed event, or 'YYYY-MM-DD' for an all-day event.",
        },
        end: {
          type: "string",
          description:
            "Optional local end in the same format as start. Timed events default to 1 hour after start. For all-day events this is the last day (inclusive).",
        },
        all_day: { type: "boolean", description: "True for an all-day event. Defaults to true when start has no time." },
        location: { type: "string" },
        description: { type: "string" },
        calendar_id: { type: "string", description: "Google calendar id. Omit to use the main calendar." },
      },
      required: ["title", "start"],
      additionalProperties: false,
    },
  },
  {
    name: "create_trello_card",
    description:
      "Create a card on one of the user's Trello lists. Use for tasks, to-dos, reminders to do something, and assignments. Pick list_id from the Trello boards and lists in the system prompt; omit it to use the default list.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Card title, phrased as a task, e.g. 'Book the restaurant'." },
        list_id: { type: "string", description: "Exact list id from the catalogue. Omit to use the default list." },
        due: {
          type: "string",
          description:
            "Optional local due date. Use 'YYYY-MM-DD' when the user gives only a day, or 'YYYY-MM-DDTHH:MM' only when they give a specific time.",
        },
        description: { type: "string" },
        labels: { type: "array", items: { type: "string" }, description: "Label names that exist on the board." },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "list_upcoming_events",
    description:
      "List events from the user's Google Calendar between two local dates (inclusive). Use to answer questions like \"what's on tomorrow?\" or to check for clashes.",
    input_schema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "First day, 'YYYY-MM-DD'. Defaults to today." },
        end_date: { type: "string", description: "Last day (inclusive), 'YYYY-MM-DD'. Defaults to 7 days after start_date." },
        calendar_id: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "delete_item",
    description:
      "Delete an event or card that this assistant created earlier. Omit ref to undo everything created by the most recent request. Pass a ref from the 'Recently created' list to delete one specific item.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "The ref of a recently created item." },
      },
      additionalProperties: false,
    },
  },
];

/** State shared by tool calls during one chat request. */
export class ToolContext {
  created: CreatedItem[] = [];
  deleted: CreatedItem[] = [];
  needsGoogle = false;
  private catalog?: TrelloCatalog;
  private order = new Map<string, number>();

  /** Record a created item, keeping items in the order the model asked for them (tools run in parallel). */
  add(item: CreatedItem, seq: number) {
    this.order.set(item.ref, seq);
    this.created.push(item);
    this.created.sort((a, b) => (this.order.get(a.ref) ?? 0) - (this.order.get(b.ref) ?? 0));
  }

  constructor(public env: Env) {}

  async trello(fresh = false): Promise<TrelloCatalog> {
    if (!this.catalog || fresh) this.catalog = await getCatalog(this.env, { fresh });
    return this.catalog;
  }
}

type Input = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export async function runTool(ctx: ToolContext, name: string, input: Input, seq = 0): Promise<unknown> {
  try {
    switch (name) {
      case "create_calendar_event":
        return await createCalendarEvent(ctx, input, seq);
      case "create_trello_card":
        return await createTrelloCard(ctx, input, seq);
      case "list_upcoming_events":
        return await listUpcoming(ctx, input);
      case "delete_item":
        return await deleteItem(ctx, str(input.ref));
      default:
        throw new Error(`Unknown tool ${name}`);
    }
  } catch (e) {
    if (e instanceof AppError && e.code === "google_not_connected") {
      ctx.needsGoogle = true;
      throw new Error(
        "Google Calendar isn't connected. Tell the user to tap the 'Connect Google' button, then try again. Do not retry.",
      );
    }
    throw e;
  }
}

// ---------- create_calendar_event ----------

const toGoogleDateTime = (local: string) => {
  const p = parseLocal(local);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:00`;
};

async function createCalendarEvent(ctx: ToolContext, input: Input, seq: number) {
  const { env } = ctx;
  const title = str(input.title);
  const start = str(input.start);
  if (!title || !start) throw new Error("title and start are required.");
  const allDay = typeof input.all_day === "boolean" ? input.all_day : isDateOnly(start);
  const calendarId = str(input.calendar_id) ?? env.GOOGLE_CALENDAR_ID ?? "primary";
  const location = str(input.location);

  let body: Parameters<typeof createEvent>[2];
  let when: string;
  if (allDay) {
    const first = start.slice(0, 10);
    const last = (str(input.end) ?? first).slice(0, 10);
    if (last < first) throw new Error("end is before start.");
    body = { summary: title, start: { date: first }, end: { date: addDays(last, 1) } }; // Google's end date is exclusive
    when = first === last ? `${prettyDate(first)} (all day)` : `${prettyDate(first)} – ${prettyDate(last)} (all day)`;
  } else {
    if (isDateOnly(start)) throw new Error("A timed event needs a start time. Ask the user what time.");
    const end = str(input.end) ?? addMinutesLocal(start, 60);
    if (isDateOnly(end) || toGoogleDateTime(end) <= toGoogleDateTime(start)) throw new Error("end must be a time after start.");
    body = {
      summary: title,
      start: { dateTime: toGoogleDateTime(start), timeZone: env.TIMEZONE },
      end: { dateTime: toGoogleDateTime(end), timeZone: env.TIMEZONE },
    };
    const sameDay = start.slice(0, 10) === end.slice(0, 10);
    when = `${prettyLocal(start)} – ${sameDay ? prettyTime(end) : prettyLocal(end)}`;
  }
  if (location) body.location = location;
  const description = str(input.description);
  if (description) body.description = description;

  const ev = await createEvent(env, calendarId, body);
  const item: CreatedItem = {
    ref: newRef(),
    kind: "event",
    id: ev.id,
    calendarId,
    title,
    when,
    where: location,
    url: ev.htmlLink,
  };
  ctx.add(item, seq);
  return { ok: true, created: "calendar event", ...item };
}

// ---------- create_trello_card ----------

async function createTrelloCard(ctx: ToolContext, input: Input, seq: number) {
  const { env } = ctx;
  const title = str(input.title);
  if (!title) throw new Error("title is required.");
  const listId = str(input.list_id);

  let target = listId ? findList(await ctx.trello(), listId) : defaultList(env, await ctx.trello());
  if (!target && listId) target = findList(await ctx.trello(true), listId); // list may be newer than the cache
  if (!target) {
    throw new Error(
      listId
        ? `No list with id ${listId}. Use an id from the catalogue, or ask the user which list.`
        : `The default list "${env.TRELLO_DEFAULT_LIST}" on board "${env.TRELLO_DEFAULT_BOARD}" wasn't found. Ask the user which list to use.`,
    );
  }
  const { board, list } = target;

  let due: string | undefined;
  let when: string | undefined;
  const dueIn = str(input.due);
  if (dueIn) {
    if (isDateOnly(dueIn)) {
      due = localToUtc(`${dueIn}T${env.TRELLO_ALL_DAY_DUE_TIME || "23:59"}`, env.TIMEZONE).toISOString();
      when = `due ${prettyDate(dueIn)}`;
    } else {
      due = localToUtc(dueIn, env.TIMEZONE).toISOString();
      when = `due ${prettyLocal(dueIn)}`;
    }
  }

  const wanted = Array.isArray(input.labels) ? input.labels.filter((l): l is string => typeof l === "string") : [];
  const idLabels: string[] = [];
  const unknownLabels: string[] = [];
  for (const name of wanted) {
    const match = board.labels.find((l) => l.name.toLowerCase() === name.trim().toLowerCase());
    if (match) idLabels.push(match.id);
    else unknownLabels.push(name);
  }

  const card = await createCard(env, { idList: list.id, name: title, desc: str(input.description), due, idLabels });
  const item: CreatedItem = {
    ref: newRef(),
    kind: "card",
    id: card.id,
    title,
    when,
    where: `${board.name} › ${list.name}`,
    url: card.shortUrl,
  };
  ctx.add(item, seq);
  return {
    ok: true,
    created: "trello card",
    ...item,
    ...(unknownLabels.length ? { labels_not_found: unknownLabels } : {}),
  };
}

// ---------- list_upcoming_events ----------

async function listUpcoming(ctx: ToolContext, input: Input) {
  const { env } = ctx;
  const tz = env.TIMEZONE;
  const startDate = str(input.start_date) ?? nowLocal(tz).date;
  const endDate = str(input.end_date) ?? addDays(startDate, 7);
  if (!isDateOnly(startDate) || !isDateOnly(endDate)) throw new Error("Dates must be YYYY-MM-DD.");
  const calendarId = str(input.calendar_id) ?? env.GOOGLE_CALENDAR_ID ?? "primary";

  const events = await listEvents(
    env,
    calendarId,
    localToUtc(`${startDate}T00:00`, tz).toISOString(),
    localToUtc(`${addDays(endDate, 1)}T00:00`, tz).toISOString(),
    50,
  );
  return {
    range: `${prettyDate(startDate)} – ${prettyDate(endDate)}`,
    count: events.length,
    events: events.map((e) => {
      const allDay = !!e.start.date;
      return {
        title: e.summary ?? "(no title)",
        start: allDay ? `${prettyDate(e.start.date!)} (all day)` : prettyLocal(utcToLocal(e.start.dateTime!, tz)),
        end: allDay ? undefined : prettyLocal(utcToLocal(e.end.dateTime!, tz)),
        location: e.location,
      };
    }),
  };
}

// ---------- delete_item / undo ----------

async function deleteOne(env: Env, item: CreatedItem): Promise<void> {
  if (item.kind === "event") await deleteEvent(env, item.calendarId ?? "primary", item.id);
  else await deleteCard(env, item.id);
}

/**
 * Delete one item by ref, or (no ref) the whole most-recent batch.
 * Shared by the delete_item tool and the Undo button.
 */
export async function undo(env: Env, ref?: string, alsoSearch: CreatedItem[] = []) {
  const batches = await getBatches(env);
  let targets: CreatedItem[];
  if (ref) {
    const item = [...alsoSearch, ...batches.flat()].find((i) => i.ref === ref);
    if (!item) throw new Error(`Nothing recent with ref ${ref}.`);
    targets = [item];
  } else {
    targets = batches.at(-1) ?? [];
  }
  if (!targets.length) return { deleted: [] as CreatedItem[], failed: [] as string[], nothing: true };

  const results = await Promise.allSettled(targets.map((i) => deleteOne(env, i)));
  const deleted = targets.filter((_, i) => results[i].status === "fulfilled");
  const failed = targets
    .map((t, i) => (results[i].status === "rejected" ? `${t.title}: ${(results[i] as PromiseRejectedResult).reason}` : null))
    .filter((x): x is string => !!x);
  await forgetItems(
    env,
    deleted.map((d) => d.ref),
  );
  return { deleted, failed, nothing: false };
}

async function deleteItem(ctx: ToolContext, ref?: string) {
  // Items created earlier in this same message aren't in the undo log yet, so search them too.
  const result = await undo(ctx.env, ref, ref ? ctx.created : []);
  ctx.created = ctx.created.filter((c) => !result.deleted.some((d) => d.ref === c.ref));
  ctx.deleted.push(...result.deleted);
  if (result.nothing) return { ok: false, message: "There is nothing recent to undo." };
  return {
    ok: result.failed.length === 0,
    deleted: result.deleted.map((d) => ({ kind: d.kind, title: d.title, when: d.when })),
    failed: result.failed,
  };
}
