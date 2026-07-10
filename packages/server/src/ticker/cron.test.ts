import { describe, expect, it } from "vitest";
import { cronFireTimesBetween, cronMatches, parseCron } from "./cron.js";

describe("cron parsing + evaluation (architecture §29/§6.1)", () => {
  it("parses spec's own weekly-report example (0 9 * * 1) and matches Monday 09:00 UTC", () => {
    const fields = parseCron("0 9 * * 1");
    // 2026-07-13 is a Monday.
    expect(cronMatches(fields, new Date("2026-07-13T09:00:00.000Z"), "UTC")).toBe(true);
    expect(cronMatches(fields, new Date("2026-07-13T09:01:00.000Z"), "UTC")).toBe(false);
    expect(cronMatches(fields, new Date("2026-07-14T09:00:00.000Z"), "UTC")).toBe(false); // Tuesday
  });

  it("honors a non-UTC IANA timezone (spec §29's own Australia/Brisbane example)", () => {
    const fields = parseCron("0 9 * * 1");
    // Australia/Brisbane is UTC+10, no DST. 09:00 Brisbane Monday = 23:00 UTC Sunday.
    const brisbaneMonday9am = new Date("2026-07-12T23:00:00.000Z");
    expect(cronMatches(fields, brisbaneMonday9am, "Australia/Brisbane")).toBe(true);
    expect(cronMatches(fields, brisbaneMonday9am, "UTC")).toBe(false);
  });

  it("supports step syntax (*/15)", () => {
    const fields = parseCron("*/15 * * * *");
    expect(cronMatches(fields, new Date("2026-07-13T00:00:00.000Z"), "UTC")).toBe(true);
    expect(cronMatches(fields, new Date("2026-07-13T00:15:00.000Z"), "UTC")).toBe(true);
    expect(cronMatches(fields, new Date("2026-07-13T00:07:00.000Z"), "UTC")).toBe(false);
  });

  it("supports range syntax (9-17 for business hours)", () => {
    const fields = parseCron("0 9-17 * * *");
    expect(cronMatches(fields, new Date("2026-07-13T09:00:00.000Z"), "UTC")).toBe(true);
    expect(cronMatches(fields, new Date("2026-07-13T17:00:00.000Z"), "UTC")).toBe(true);
    expect(cronMatches(fields, new Date("2026-07-13T18:00:00.000Z"), "UTC")).toBe(false);
    expect(cronMatches(fields, new Date("2026-07-13T08:00:00.000Z"), "UTC")).toBe(false);
  });

  it("day-of-month OR day-of-week when both are restricted (standard cron semantics)", () => {
    // "the 1st of the month OR a Monday"
    const fields = parseCron("0 0 1 * 1");
    expect(cronMatches(fields, new Date("2026-08-01T00:00:00.000Z"), "UTC")).toBe(true); // 1st (a Saturday)
    expect(cronMatches(fields, new Date("2026-07-13T00:00:00.000Z"), "UTC")).toBe(true); // a Monday, not the 1st
    expect(cronMatches(fields, new Date("2026-07-14T00:00:00.000Z"), "UTC")).toBe(false); // neither
  });

  it("rejects a malformed expression (wrong field count)", () => {
    expect(() => parseCron("0 9 * *")).toThrow();
  });

  it("cronFireTimesBetween finds every occurrence in a window, ascending", () => {
    const fires = cronFireTimesBetween("*/30 * * * *", "UTC", new Date("2026-07-13T00:00:00.000Z"), new Date("2026-07-13T02:00:00.000Z"));
    expect(fires.map((d) => d.toISOString())).toEqual([
      "2026-07-13T00:30:00.000Z",
      "2026-07-13T01:00:00.000Z",
      "2026-07-13T01:30:00.000Z",
      "2026-07-13T02:00:00.000Z",
    ]);
  });

  it("cronFireTimesBetween excludes the exclusive lower bound and includes the inclusive upper bound", () => {
    const fires = cronFireTimesBetween("* * * * *", "UTC", new Date("2026-07-13T00:00:00.000Z"), new Date("2026-07-13T00:02:00.000Z"));
    expect(fires.map((d) => d.toISOString())).toEqual(["2026-07-13T00:01:00.000Z", "2026-07-13T00:02:00.000Z"]);
  });
});
