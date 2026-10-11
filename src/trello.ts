import { AppError, type Env } from "./env";

const API = "https://api.trello.com/1";
const CACHE_KEY = "trello:catalog";
const CACHE_TTL = 3600; // 1 hour

export interface TrelloCatalog {
  boards: {
    id: string;
    name: string;
    url: string;
    lists: { id: string; name: string }[];
    labels: { id: string; name: string; color: string | null }[];
  }[];
}

function auth(env: Env): string {
  if (!env.TRELLO_API_KEY || !env.TRELLO_TOKEN) {
    throw new AppError("trello_not_configured", "Trello isn't set up (TRELLO_API_KEY / TRELLO_TOKEN secrets missing).", 500);
  }
  return `key=${encodeURIComponent(env.TRELLO_API_KEY)}&token=${encodeURIComponent(env.TRELLO_TOKEN)}`;
}

async function trello<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${API}${path}${sep}${auth(env)}`, init).catch(() => {
    throw new AppError("trello_error", "Couldn't reach Trello. Try again in a moment.", 502);
  });
  if (!res.ok) {
    const text = await res.text();
    const msg = res.status === 401 ? "Trello rejected the API key/token." : `Trello error ${res.status}: ${text.slice(0, 200)}`;
    throw new AppError("trello_error", msg, 502);
  }
  return (await res.json()) as T;
}

/** All open boards with their lists and labels, cached in KV for an hour. */
export async function getCatalog(env: Env, { fresh = false } = {}): Promise<TrelloCatalog> {
  if (!fresh) {
    const cached = await env.KV.get<TrelloCatalog>(CACHE_KEY, "json");
    if (cached) return cached;
  }
  type RawBoard = { id: string; name: string; url: string; lists?: { id: string; name: string }[] };
  const boards = await trello<RawBoard[]>(env, "/members/me/boards?filter=open&fields=name,url&lists=open&list_fields=name");
  const catalog: TrelloCatalog = {
    boards: await Promise.all(
      boards.map(async (b) => ({
        id: b.id,
        name: b.name,
        url: b.url,
        lists: (b.lists ?? []).map((l) => ({ id: l.id, name: l.name })),
        labels: (await trello<{ id: string; name: string; color: string | null }[]>(env, `/boards/${b.id}/labels?fields=name,color&limit=100`)).map(
          (l) => ({ id: l.id, name: l.name, color: l.color }),
        ),
      })),
    ),
  };
  await env.KV.put(CACHE_KEY, JSON.stringify(catalog), { expirationTtl: CACHE_TTL });
  return catalog;
}

export function findList(catalog: TrelloCatalog, listId: string) {
  for (const board of catalog.boards) {
    const list = board.lists.find((l) => l.id === listId);
    if (list) return { board, list };
  }
  return null;
}

export function defaultList(env: Env, catalog: TrelloCatalog) {
  const eq = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const boards = env.TRELLO_DEFAULT_BOARD ? catalog.boards.filter((b) => eq(b.name, env.TRELLO_DEFAULT_BOARD)) : catalog.boards;
  for (const board of boards) {
    const list = board.lists.find((l) => eq(l.name, env.TRELLO_DEFAULT_LIST));
    if (list) return { board, list };
  }
  return null;
}

export interface TrelloCard {
  id: string;
  name: string;
  shortUrl: string;
  due: string | null;
}

export async function createCard(
  env: Env,
  card: { idList: string; name: string; desc?: string; due?: string; idLabels?: string[] },
): Promise<TrelloCard> {
  const params = new URLSearchParams({ idList: card.idList, name: card.name, pos: "top" });
  if (card.desc) params.set("desc", card.desc);
  if (card.due) params.set("due", card.due);
  if (card.idLabels?.length) params.set("idLabels", card.idLabels.join(","));
  return trello<TrelloCard>(env, `/cards?${params}`, { method: "POST" });
}

export async function deleteCard(env: Env, cardId: string): Promise<void> {
  const res = await fetch(`${API}/cards/${encodeURIComponent(cardId)}?${auth(env)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    throw new AppError("trello_error", `Couldn't delete the Trello card (${res.status}).`, 502);
  }
}
