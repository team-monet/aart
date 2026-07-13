// jsdom (this package's vitest.config.ts `environment`) does not implement
// EventSource — verified directly (neither jsdom nor plain Node 22 expose a
// global EventSource; @Claude/browser tools not applicable to a unit test
// process). A minimal stand-in, stubbed the same way test-support/
// mock-fetch.ts stands in for global.fetch: ActivityFeedPage.tsx only ever
// reads `.onopen`/`.onmessage`/`.onerror` off it and calls `.close()`, so a
// plain class shaped like that is simpler than a real EventSource polyfill
// and has no dependency on jsdom ever adding one.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { renderWithRouter } from "../test-support/render";
import { mockFetchJson } from "../test-support/mock-fetch";
import { makeEvent } from "../test-support/fixtures";
import { ActivityFeedPage } from "./ActivityFeedPage";

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}

afterEach(() => {
  MockEventSource.instances = [];
});

describe("ActivityFeedPage", () => {
  it("backfills the feed from GET /api/events on mount, newest-first as returned", async () => {
    const newer = makeEvent({ id: "evt-2", type: "run.completed", summary: "Run finished", occurredAt: "2026-07-10T00:05:00.000Z" });
    const older = makeEvent({ id: "evt-1", type: "run.failed", summary: "Run blew up", occurredAt: "2026-07-10T00:00:00.000Z" });
    vi.stubGlobal("fetch", mockFetchJson({ "/api/events?": [newer, older] }));
    vi.stubGlobal("EventSource", MockEventSource);

    renderWithRouter(<ActivityFeedPage />);

    expect(await screen.findByText("Activity Feed")).toBeTruthy();
    expect(await screen.findByText("Run finished")).toBeTruthy();
    expect(await screen.findByText("Run blew up")).toBeTruthy();

    // A same-origin, relative EventSource URL — the SPA's "never knows the
    // real server's address" invariant (this package's own header comments)
    // applies to the stream just as much as to every fetch() call.
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0]?.url).toBe("/api/events/stream");
  });

  it("prepends a live event delivered over the stream and dedupes by id, without disturbing the backfilled rows", async () => {
    const backfilled = makeEvent({ id: "evt-1", type: "run.completed", summary: "Backfilled run" });
    vi.stubGlobal("fetch", mockFetchJson({ "/api/events?": [backfilled] }));
    vi.stubGlobal("EventSource", MockEventSource);

    renderWithRouter(<ActivityFeedPage />);
    expect(await screen.findByText("Backfilled run")).toBeTruthy();

    const source = MockEventSource.instances[0];
    if (!source) throw new Error("no EventSource was constructed");
    const live = makeEvent({ id: "evt-live", type: "approval.decided", summary: "Approved by alice" });

    act(() => {
      source.onmessage?.({ data: JSON.stringify(live) });
    });
    expect(await screen.findByText("Approved by alice")).toBeTruthy();
    expect(await screen.findByText("Backfilled run")).toBeTruthy(); // still there, not replaced

    // Redelivering the SAME event (id) must not duplicate the row.
    act(() => {
      source.onmessage?.({ data: JSON.stringify(live) });
    });
    expect(screen.getAllByText("Approved by alice")).toHaveLength(1);
  });

  // Wave 2 fix pass (AMENDMENTS.md A67 FIX 6, minor): a long-open tab's live
  // feed used to grow the events array with no bound at all. MAX_FEED_EVENTS
  // (500, ActivityFeedPage.tsx) caps it -- backfill 500 (already at the
  // cap), delivering one more live event must evict the oldest rather than
  // grow to 501.
  it("caps the live feed at the newest MAX_FEED_EVENTS entries so a long-open tab doesn't grow the array unboundedly", async () => {
    const MAX_FEED_EVENTS = 500; // must match ActivityFeedPage.tsx's own cap
    const backfilled = Array.from({ length: MAX_FEED_EVENTS }, (_, i) =>
      makeEvent({ id: `evt-${i}`, type: "run.completed", summary: `Backfilled run ${i}`, occurredAt: `2026-07-10T00:${String(i % 60).padStart(2, "0")}:00.000Z` }),
    );
    vi.stubGlobal("fetch", mockFetchJson({ "/api/events?": backfilled }));
    vi.stubGlobal("EventSource", MockEventSource);

    renderWithRouter(<ActivityFeedPage />);
    expect(await screen.findByText("Backfilled run 0")).toBeTruthy(); // the feed is already at the cap after backfill

    const source = MockEventSource.instances[0];
    if (!source) throw new Error("no EventSource was constructed");
    const live = makeEvent({ id: "evt-live", type: "approval.decided", summary: "Approved by alice" });

    act(() => {
      source.onmessage?.({ data: JSON.stringify(live) });
    });

    expect(await screen.findByText("Approved by alice")).toBeTruthy(); // the new live event lands at the top
    expect(screen.queryByText(`Backfilled run ${MAX_FEED_EVENTS - 1}`)).toBeNull(); // the oldest entry (last of the original 500) was evicted to make room, keeping the array at the cap
    expect(screen.getByText("Backfilled run 0")).toBeTruthy(); // the newest backfilled entry is still retained, right below the new live one
  });
});
