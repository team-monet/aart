// Minimal 5-field cron parser/evaluator with IANA timezone support
// (architecture §29/§6.1: "computes next-fire time honoring the given IANA
// timezone"). Hand-rolled rather than adding a cron-parsing dependency —
// the grammar this needs (standard 5-field cron: minute hour day-of-month
// month day-of-week, with `*`, `*/n`, `a-b`, `a-b/n`, and comma lists) is
// small and well-specified, and timezone-aware wall-clock computation is
// available natively via `Intl.DateTimeFormat`'s `timeZone` option — no
// third-party timezone database needed.
export interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  daysOfMonthRestricted: boolean;
  daysOfWeekRestricted: boolean;
}

function parseField(raw: string, min: number, max: number): { values: Set<number>; restricted: boolean } {
  const values = new Set<number>();
  let restricted = raw !== "*";
  for (const part of raw.split(",")) {
    const stepMatch = /^(\*|\d+-\d+|\d+)\/(\d+)$/.exec(part);
    if (stepMatch) {
      const [, range, stepStr] = stepMatch;
      const step = Number(stepStr);
      let lo = min;
      let hi = max;
      if (range !== "*") {
        const rangeMatch = /^(\d+)-(\d+)$/.exec(range!);
        if (rangeMatch) {
          lo = Number(rangeMatch[1]);
          hi = Number(rangeMatch[2]);
        } else {
          lo = hi = Number(range);
        }
      }
      for (let v = lo; v <= hi; v += step) values.add(v);
      continue;
    }
    const rangeMatch = /^(\d+)-(\d+)$/.exec(part);
    if (rangeMatch) {
      const lo = Number(rangeMatch[1]);
      const hi = Number(rangeMatch[2]);
      for (let v = lo; v <= hi; v++) values.add(v);
      continue;
    }
    if (part === "*") {
      for (let v = min; v <= max; v++) values.add(v);
      continue;
    }
    const n = Number(part);
    if (Number.isNaN(n)) {
      throw new Error(`Invalid cron field segment "${part}" in field "${raw}"`);
    }
    values.add(n);
  }
  return { values, restricted };
}

export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Cron expression "${expr}" must have exactly 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`);
  }
  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];
  const minutes = parseField(minute, 0, 59);
  const hours = parseField(hour, 0, 23);
  const daysOfMonth = parseField(dom, 1, 31);
  const months = parseField(month, 1, 12);
  const daysOfWeek = parseField(dow, 0, 6);
  return {
    minutes: minutes.values,
    hours: hours.values,
    daysOfMonth: daysOfMonth.values,
    months: months.values,
    daysOfWeek: daysOfWeek.values,
    daysOfMonthRestricted: daysOfMonth.restricted,
    daysOfWeekRestricted: daysOfWeek.restricted,
  };
}

interface ZonedParts {
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number; // 0=Sunday .. 6=Saturday
}

const weekdayIndex: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function zonedParts(date: Date, timezone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const hourStr = get("hour");
  return {
    minute: Number(get("minute")),
    // Intl can render midnight as "24" for hour12:false in some engines'
    // implementations — normalize.
    hour: Number(hourStr) % 24,
    day: Number(get("day")),
    month: Number(get("month")),
    weekday: weekdayIndex[get("weekday")] ?? 0,
  };
}

export function cronMatches(fields: CronFields, date: Date, timezone: string): boolean {
  const p = zonedParts(date, timezone);
  if (!fields.minutes.has(p.minute)) return false;
  if (!fields.hours.has(p.hour)) return false;
  if (!fields.months.has(p.month)) return false;
  const domMatch = fields.daysOfMonth.has(p.day);
  const dowMatch = fields.daysOfWeek.has(p.weekday);
  // Standard cron semantics: if BOTH day-of-month and day-of-week are
  // restricted (not "*"), a date matches if EITHER matches (OR). If only
  // one is restricted, that one alone gates the match.
  if (fields.daysOfMonthRestricted && fields.daysOfWeekRestricted) {
    return domMatch || dowMatch;
  }
  if (fields.daysOfMonthRestricted) return domMatch;
  if (fields.daysOfWeekRestricted) return dowMatch;
  return true;
}

/** Every minute-boundary fire time in `(fromExclusive, toInclusive]`, ascending. Bounded, brute-force-per-minute — fine at the window sizes this package actually uses (a single tick interval for the steady-state case, a bounded missed-run lookback at startup, architecture §29's "missed-run policy" — see ticker/ticker.ts). */
export function cronFireTimesBetween(expr: string, timezone: string, fromExclusive: Date, toInclusive: Date): Date[] {
  const fields = parseCron(expr);
  const fires: Date[] = [];
  let cursor = new Date(Math.ceil(fromExclusive.getTime() / 60_000) * 60_000);
  if (cursor.getTime() === fromExclusive.getTime()) {
    cursor = new Date(cursor.getTime() + 60_000);
  }
  const guardMax = 6 * 366 * 24 * 60; // ~6 years of minutes — a hard safety bound against a pathological expression
  let iterations = 0;
  while (cursor.getTime() <= toInclusive.getTime() && iterations < guardMax) {
    if (cronMatches(fields, cursor, timezone)) fires.push(new Date(cursor));
    cursor = new Date(cursor.getTime() + 60_000);
    iterations += 1;
  }
  return fires;
}
