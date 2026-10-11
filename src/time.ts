// Small timezone helpers built on Intl, so we don't need a date library.
// "Local" strings are wall-clock times in the configured zone: "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM".

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

export function isDateOnly(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export function parseLocal(s: string): { y: number; mo: number; d: number; h: number; mi: number; hasTime: boolean } {
  const m = LOCAL_RE.exec(s.trim());
  if (!m) throw new Error(`Invalid date "${s}". Use YYYY-MM-DD or YYYY-MM-DDTHH:MM (local time, no offset).`);
  return { y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] ?? 0), mi: +(m[5] ?? 0), hasTime: m[4] !== undefined };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Offset of `tz` from UTC at instant `date`, in minutes (Adelaide is +570 or +630). */
export function tzOffsetMinutes(date: Date, tz: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(date)
    .find((p) => p.type === "timeZoneName")?.value;
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name ?? "");
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +(m[3] ?? 0));
}

/** Convert a local wall-clock string in `tz` to a UTC Date. */
export function localToUtc(local: string, tz: string): Date {
  const p = parseLocal(local);
  const guess = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
  const off1 = tzOffsetMinutes(new Date(guess), tz);
  let utc = guess - off1 * 60_000;
  const off2 = tzOffsetMinutes(new Date(utc), tz);
  if (off2 !== off1) utc = guess - off2 * 60_000; // crossed a DST boundary
  return new Date(utc);
}

/** Wall-clock arithmetic on a local string (ignores DST, which Google resolves for us). */
export function addMinutesLocal(local: string, minutes: number): string {
  const p = parseLocal(local);
  const t = new Date(Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) + minutes * 60_000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
}

export function addDays(date: string, days: number): string {
  const p = parseLocal(date);
  const t = new Date(Date.UTC(p.y, p.mo - 1, p.d) + days * 86_400_000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Current local date/time parts in `tz`. */
export function nowLocal(tz: string, now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { date, time: `${parts.hour}:${parts.minute}`, offsetMinutes: tzOffsetMinutes(now, tz) };
}

export function formatOffset(min: number): string {
  const sign = min < 0 ? "-" : "+";
  const a = Math.abs(min);
  return `UTC${sign}${Math.floor(a / 60)}${a % 60 ? ":" + pad(a % 60) : ""}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Thu 15 Oct" (date only) — for a local date string. */
export function prettyDate(date: string): string {
  const p = parseLocal(date);
  const wd = new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay();
  return `${WEEKDAYS[wd]} ${p.d} ${MONTHS[p.mo - 1]}`;
}

/** "3:00 pm" — the time part of a local string. */
export function prettyTime(local: string): string {
  const p = parseLocal(local);
  return `${p.h % 12 || 12}:${pad(p.mi)} ${p.h < 12 ? "am" : "pm"}`;
}

/** "Thu 15 Oct, 3:00 pm" — for a local string with time. */
export function prettyLocal(local: string): string {
  return parseLocal(local).hasTime ? `${prettyDate(local)}, ${prettyTime(local)}` : prettyDate(local);
}

/** Format a UTC instant (e.g. an RFC3339 string from Google) as local "YYYY-MM-DDTHH:MM". */
export function utcToLocal(iso: string, tz: string): string {
  const n = nowLocal(tz, new Date(iso));
  return `${n.date}T${n.time}`;
}
