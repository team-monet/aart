import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithRouter } from "../test-support/render";
import { mockFetchJson } from "../test-support/mock-fetch";
import { makeEvalSuite } from "../test-support/fixtures";
import { EvalsPage } from "./EvalsPage";

describe("EvalsPage", () => {
  it("renders suites and run summaries (EvalRun.passed/total, this session's typing-pass fix) from a fetch mock", async () => {
    const suite = makeEvalSuite({ id: "suite-1", name: "Accuracy Suite" });
    vi.stubGlobal(
      "fetch",
      mockFetchJson({
        "/api/evals": {
          suites: [suite],
          runs: [
            {
              id: "evalrun-1",
              suiteId: "suite-1",
              workflowId: "wf-1",
              workflowVersion: "1.0.0",
              status: "completed",
              total: 4,
              passed: 3,
              failed: 1,
              score: 0.75,
              regressions: [],
              improvements: [],
              reportArtifact: "a1",
            },
          ],
        },
        "/api/workflows": ["wf-1"],
      }),
    );

    const { container } = renderWithRouter(<EvalsPage />);

    expect(await screen.findByText("Evaluation Suites")).toBeTruthy();
    expect(await screen.findByText("Accuracy Suite")).toBeTruthy();
    // Regression check for the run.summary.{passed,total} -> run.{passed,total}
    // fix: EvalRun has no nested `summary` object, so the old read would
    // have rendered "0 / 0" instead of the real counts.
    expect(container.textContent).toContain("3 / 4");
  });
});
