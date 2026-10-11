export interface Env {
  ASSETS: Fetcher;
  AI: Ai;
  KV: KVNamespace;

  // vars (wrangler.toml)
  TIMEZONE: string;
  ANTHROPIC_MODEL: string;
  ANTHROPIC_EFFORT: string;
  GOOGLE_CALENDAR_ID: string;
  TRELLO_DEFAULT_BOARD: string;
  TRELLO_DEFAULT_LIST: string;
  TRELLO_ALL_DAY_DUE_TIME: string;

  // secrets (`wrangler secret put`)
  ANTHROPIC_API_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  TRELLO_API_KEY: string;
  TRELLO_TOKEN: string;
  APP_PASSWORD: string;
}

/** Something the agent created, kept so it can be shown in the UI and undone later. */
export interface CreatedItem {
  ref: string; // short id the model can use with delete_item
  kind: "event" | "card";
  id: string; // Google event id / Trello card id
  calendarId?: string;
  title: string;
  when?: string; // human-readable, already in local time
  where?: string; // location for events, "Board › List" for cards
  url?: string;
}

/** Errors with a stable code the frontend can act on (e.g. show a "Connect Google" button). */
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
