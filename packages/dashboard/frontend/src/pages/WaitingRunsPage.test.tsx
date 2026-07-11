import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithRouter } from "../test-support/render";
import { mockFetchJson } from "../test-support/mock-fetch";
import { WaitingRunsPage } from "./WaitingRunsPage";

describe("WaitingRunsPage", () => {
  it("renders waiting runs from a fetch mock", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchJson({
        "/api/waiting-runs": {
          waitingRuns: [{ runId: "run-wait-1", stepId: "step1", wait: { type: "approval", taskId: "t1", schemaVersion: 1 }, createdAt: "2026-07-10T00:00:00.000Z" }],
          now: "2026-07-10T00:05:00.000Z",
        },
      }),
    );

    renderWithRouter(<WaitingRunsPage />);

    expect(await screen.findByText("Waiting Runs")).toBeTruthy();
    expect(await screen.findByText("run-wait-1")).toBeTruthy();
  });
});
