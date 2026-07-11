import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithRouter } from "../test-support/render";
import { mockFetchJson } from "../test-support/mock-fetch";
import { makeCorrection } from "../test-support/fixtures";
import { CorrectionsPage } from "./CorrectionsPage";

describe("CorrectionsPage", () => {
  it("renders the corrections list (default, non-form mode) from a fetch mock", async () => {
    const correction = makeCorrection({ runId: "run-corr-1", stepId: "step1" });
    vi.stubGlobal(
      "fetch",
      mockFetchJson({
        "/api/corrections": [correction],
        "/api/evals": { suites: [], runs: [] },
      }),
    );

    renderWithRouter(<CorrectionsPage />);

    expect(await screen.findByText("Corrections")).toBeTruthy();
    expect(await screen.findByText("run-corr-1")).toBeTruthy();
  });
});
