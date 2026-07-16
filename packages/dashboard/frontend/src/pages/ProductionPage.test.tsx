import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithRouter } from "../test-support/render";
import { mockFetchJson } from "../test-support/mock-fetch";
import { makeEnvironment } from "../test-support/fixtures";
import { ProductionPage } from "./ProductionPage";

describe("ProductionPage", () => {
  it("renders environments (the default tab) from a fetch mock", async () => {
    const env = makeEnvironment({ id: "env-1", name: "staging", config: { trustMode: "governed" } });
    vi.stubGlobal(
      "fetch",
      mockFetchJson({
        "/api/environments": [env],
      }),
    );

    renderWithRouter(<ProductionPage />);

    expect(await screen.findByText("Production Ops")).toBeTruthy();
    expect(await screen.findByText("staging")).toBeTruthy();
  });
});
