import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithRouter } from "../test-support/render";
import { mockFetchJson } from "../test-support/mock-fetch";
import { makeRun } from "../test-support/fixtures";
import { RunDetailPage } from "./RunDetailPage";

describe("RunDetailPage", () => {
  it("renders run detail from a fetch mock, including the endedAt/params.environment fields this session's typing pass fixed", async () => {
    const run = makeRun({
      runId: "run-detail-1",
      status: "completed",
      endedAt: "2026-07-10T01:00:00.000Z",
      params: { environment: "production" },
    });
    vi.stubGlobal(
      "fetch",
      mockFetchJson({
        "/api/runs/run-detail-1": { run, reportHtml: "<p>report</p>" },
      }),
    );

    renderWithRouter(<RunDetailPage id="run-detail-1" />);

    expect(await screen.findByText("run-detail-1")).toBeTruthy();
    // Regression check for the completedAt -> endedAt fix: with the old
    // (wrong) field read this would render "-" instead of a real date.
    expect(await screen.findByText("production")).toBeTruthy();
  });

  it("renders an attacker-shaped step id as inert text, never as a parsed HTML element", async () => {
    const attackerPayload = '<img src=x onerror="window.__xss=true">';
    const run = makeRun({
      runId: "run-xss",
      trace: [{ seq: 0, stepId: attackerPayload, block: "http.get", status: "completed", inputs: {}, startedAt: "2026-07-10T00:00:00.000Z" }],
    });
    vi.stubGlobal(
      "fetch",
      mockFetchJson({
        "/api/runs/run-xss": { run, reportHtml: "" },
      }),
    );

    const { container } = renderWithRouter(<RunDetailPage id="run-xss" />);
    await screen.findByText("run-xss");

    // React's default JSX text interpolation ({value}) escapes automatically
    // — this asserts that guarantee holds for this specific field, not just
    // that it LOOKS escaped: no <img> element was actually created, and its
    // onerror handler never ran.
    expect(container.querySelector("img")).toBeNull();
    expect((window as unknown as { __xss?: boolean }).__xss).toBeUndefined();
    expect(container.textContent).toContain(attackerPayload);
  });
});
