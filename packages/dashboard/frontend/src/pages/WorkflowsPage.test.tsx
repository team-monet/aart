import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithRouter } from "../test-support/render";
import { mockFetchJson } from "../test-support/mock-fetch";
import { WorkflowsPage } from "./WorkflowsPage";

describe("WorkflowsPage", () => {
  it("renders the workflow id list (no id prop -> list mode) from a fetch mock", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchJson({
        "/api/workflows": ["wf-1"],
      }),
    );

    renderWithRouter(<WorkflowsPage />);

    expect(await screen.findByText("Workflows")).toBeTruthy();
    expect(await screen.findByText("wf-1")).toBeTruthy();
  });
});
