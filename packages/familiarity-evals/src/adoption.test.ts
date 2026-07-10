import { describe, expect, it } from "vitest";
import { scoreToolChoice } from "./adoption.js";

const task = { id: "choice1", prompt: "Check whether the API is healthy." };

describe("scoreToolChoice — spec §32.4's 4th named metric (unprompted-adoption rate)", () => {
  it("choseAart is true when the response contains an AART block-shaped marker", () => {
    expect(scoreToolChoice(task, "uses: http.health_check\nwith:\n  url: https://example.com").choseAart).toBe(true);
  });

  it("choseAart is false when the response reaches for a generic tool instead, with no AART marker", () => {
    expect(scoreToolChoice(task, "curl -sf https://example.com/health").choseAart).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(scoreToolChoice(task, "USES: HTTP.REQUEST").choseAart).toBe(true);
  });

  it("carries the task id through onto the result", () => {
    expect(scoreToolChoice(task, "uses: http.request").taskId).toBe("choice1");
  });
});
