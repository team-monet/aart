import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithRouter } from "../test-support/render";
import { mockFetchJson } from "../test-support/mock-fetch";
import { makeRun } from "../test-support/fixtures";
import { FlaggedRunsPage } from "./FlaggedRunsPage";

describe("FlaggedRunsPage", () => {
  it("renders flagged runs from a fetch mock", async () => {
    const run = makeRun({ runId: "run-flag-1", status: "failed", flag: { kind: "poison", flaggedAt: "2026-07-10T00:00:00.000Z" } });
    vi.stubGlobal(
      "fetch",
      mockFetchJson({
        "/api/flagged-runs": [run],
      }),
    );

    renderWithRouter(<FlaggedRunsPage />);

    expect(await screen.findByText("Flagged Runs")).toBeTruthy();
    expect(await screen.findByText("run-flag-1")).toBeTruthy();
  });
});
