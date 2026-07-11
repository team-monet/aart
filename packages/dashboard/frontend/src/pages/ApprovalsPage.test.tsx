import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithRouter } from "../test-support/render";
import { mockFetchJson } from "../test-support/mock-fetch";
import { makeApprovalTask } from "../test-support/fixtures";
import { ApprovalsPage } from "./ApprovalsPage";

describe("ApprovalsPage", () => {
  it("renders the approvals queue from a fetch mock", async () => {
    const task = makeApprovalTask({ id: "task-1", title: "Ship it?" });
    vi.stubGlobal(
      "fetch",
      mockFetchJson({
        "/api/approvals": [task],
      }),
    );

    renderWithRouter(<ApprovalsPage />);

    expect(await screen.findByText("Approvals Queue")).toBeTruthy();
    expect(await screen.findByText("Ship it?")).toBeTruthy();
  });
});
