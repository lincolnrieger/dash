import type { CreatedItem, Env } from "./env";

// ---------- Chat history (plain text turns, last ~10 messages) ----------

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

const HISTORY_KEY = "chat:history";
const HISTORY_MAX = 10;
const HISTORY_TTL = 60 * 60 * 24 * 7; // forget the conversation after a week of silence

export async function getHistory(env: Env): Promise<ChatTurn[]> {
  return (await env.KV.get<ChatTurn[]>(HISTORY_KEY, "json")) ?? [];
}

export async function appendHistory(env: Env, ...turns: ChatTurn[]): Promise<void> {
  let history = [...(await getHistory(env)), ...turns].slice(-HISTORY_MAX);
  // The Messages API needs the conversation to start with a user turn.
  while (history.length && history[0].role !== "user") history = history.slice(1);
  await env.KV.put(HISTORY_KEY, JSON.stringify(history), { expirationTtl: HISTORY_TTL });
}

export async function clearHistory(env: Env): Promise<void> {
  await env.KV.delete(HISTORY_KEY);
}

// ---------- Undo log: a stack of batches, one batch per message ----------

const UNDO_KEY = "undo:batches";
const UNDO_MAX = 10;

export async function getBatches(env: Env): Promise<CreatedItem[][]> {
  return (await env.KV.get<CreatedItem[][]>(UNDO_KEY, "json")) ?? [];
}

async function saveBatches(env: Env, batches: CreatedItem[][]): Promise<void> {
  await env.KV.put(UNDO_KEY, JSON.stringify(batches.filter((b) => b.length).slice(-UNDO_MAX)));
}

export async function pushBatch(env: Env, items: CreatedItem[]): Promise<void> {
  if (!items.length) return;
  await saveBatches(env, [...(await getBatches(env)), items]);
}

/** Remove items (by ref) from wherever they are in the log. */
export async function forgetItems(env: Env, refs: string[]): Promise<void> {
  const batches = await getBatches(env);
  await saveBatches(
    env,
    batches.map((b) => b.filter((i) => !refs.includes(i.ref))),
  );
}

export function newRef(): string {
  return crypto.randomUUID().slice(0, 6);
}
