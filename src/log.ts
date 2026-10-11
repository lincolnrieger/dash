import type { Env } from "./env";

// A simple activity log (newest first) shown under ⋯ → Activity.

export type LogKind = "created" | "deleted" | "undo" | "google" | "trello" | "login" | "error";

export interface LogEntry {
  at: string; // ISO timestamp
  kind: LogKind;
  text: string;
  url?: string;
}

const LOG_KEY = "log:actions";
const LOG_MAX = 200;

export async function getLog(env: Env): Promise<LogEntry[]> {
  return (await env.KV.get<LogEntry[]>(LOG_KEY, "json")) ?? [];
}

export async function logActions(env: Env, entries: Omit<LogEntry, "at">[]): Promise<void> {
  if (!entries.length) return;
  const at = new Date().toISOString();
  const log = [...entries.map((e) => ({ at, ...e })).reverse(), ...(await getLog(env))].slice(0, LOG_MAX);
  await env.KV.put(LOG_KEY, JSON.stringify(log));
}

export async function clearLog(env: Env): Promise<void> {
  await env.KV.delete(LOG_KEY);
}
