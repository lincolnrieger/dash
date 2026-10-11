import type { Env } from "./env";
import { nowLocal } from "./time";

// Anthropic doesn't expose your credit balance to a normal API key, so Dash adds up what each
// request costs (from the token counts the API returns) and, if you tell it how much credit you
// loaded, works out what's left. Check console.anthropic.com for the exact figures.

/** US$ per million tokens: [input, output]. Cache reads cost 0.1x input, cache writes 1.25x. */
const PRICES: Record<string, [number, number]> = {
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-sonnet-5-5": [2, 10],
  "claude-sonnet-5": [2, 10],
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
};

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export function costUsd(model: string, u: TokenUsage): number {
  const key = Object.keys(PRICES).find((k) => model.startsWith(k)) ?? "claude-sonnet-5-5";
  const [inRate, outRate] = PRICES[key];
  const input =
    u.input_tokens + (u.cache_creation_input_tokens ?? 0) * 1.25 + (u.cache_read_input_tokens ?? 0) * 0.1;
  return (input * inRate + u.output_tokens * outRate) / 1_000_000;
}

interface Bucket {
  cost: number;
  requests: number;
  tokensIn: number;
  tokensOut: number;
}
interface Totals {
  allTime: Bucket;
  days: Record<string, Bucket>; // "YYYY-MM-DD" (local)
  months: Record<string, Bucket>; // "YYYY-MM"
}
interface Credit {
  amount: number; // US$ balance when it was set
  spentAtSet: number; // allTime.cost at that moment
  setAt: string;
}

const TOTALS_KEY = "usage:totals";
const CREDIT_KEY = "usage:credit";
const empty = (): Bucket => ({ cost: 0, requests: 0, tokensIn: 0, tokensOut: 0 });

async function getTotals(env: Env): Promise<Totals> {
  return (await env.KV.get<Totals>(TOTALS_KEY, "json")) ?? { allTime: empty(), days: {}, months: {} };
}

/** Add one chat request (which may span several API calls) to the running totals. */
export async function recordUsage(env: Env, cost: number, tokensIn: number, tokensOut: number): Promise<void> {
  const totals = await getTotals(env);
  const day = nowLocal(env.TIMEZONE).date;
  const month = day.slice(0, 7);
  for (const b of [totals.allTime, (totals.days[day] ??= empty()), (totals.months[month] ??= empty())]) {
    b.cost += cost;
    b.requests += 1;
    b.tokensIn += tokensIn;
    b.tokensOut += tokensOut;
  }
  // Keep the last 60 days and 24 months.
  totals.days = Object.fromEntries(Object.entries(totals.days).sort().slice(-60));
  totals.months = Object.fromEntries(Object.entries(totals.months).sort().slice(-24));
  await env.KV.put(TOTALS_KEY, JSON.stringify(totals));
}

export async function usageSummary(env: Env) {
  const [totals, credit] = await Promise.all([getTotals(env), env.KV.get<Credit>(CREDIT_KEY, "json")]);
  const day = nowLocal(env.TIMEZONE).date;
  const last7 = Object.entries(totals.days)
    .filter(([d]) => d > shiftDay(day, -7))
    .reduce((s, [, b]) => s + b.cost, 0);
  return {
    model: env.ANTHROPIC_MODEL,
    today: totals.days[day] ?? empty(),
    last7Days: last7,
    thisMonth: totals.months[day.slice(0, 7)] ?? empty(),
    allTime: totals.allTime,
    credit: credit
      ? { amount: credit.amount, setAt: credit.setAt, remaining: credit.amount - (totals.allTime.cost - credit.spentAtSet) }
      : null,
  };
}

/** Remember the current credit balance; spending from now on counts down from it. */
export async function setCredit(env: Env, amount: number | null): Promise<void> {
  if (amount === null) return env.KV.delete(CREDIT_KEY);
  const totals = await getTotals(env);
  const credit: Credit = { amount, spentAtSet: totals.allTime.cost, setAt: new Date().toISOString() };
  await env.KV.put(CREDIT_KEY, JSON.stringify(credit));
}

function shiftDay(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
