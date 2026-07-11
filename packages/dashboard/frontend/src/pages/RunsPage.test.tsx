import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithRouter } from "../test-support/render";
import { mockFetchJson } from "../test-support/mock-fetch";
import { makeRun } from "../test-support/fixtures";
import { RunsPage } from "./RunsPage";

describe("RunsPage", () => {
  it("renders the runs list from a fetch mock", async () => {
    const run = makeRun({ runId: "run-abc", workflowId: "wf-1", status: "completed" });
    vi.stubGlobal(
      "fetch",
      mockFetchJson({
        "/api/runs?": [run],
        "/api/workflows": ["wf-1"],
      }),
    );

    renderWithRouter(<RunsPage />);

    expect(await screen.findByText("Workflow Runs")).toBeTruthy();
    expect(await screen.findByText("run-abc")).toBeTruthy();
  });
});
