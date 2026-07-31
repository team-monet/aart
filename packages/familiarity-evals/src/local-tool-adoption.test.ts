import { describe, expect, it } from "vitest";
import {
  compareReuseDiscovery,
  REUSE_DISCOVERY_TASK_CATALOG,
  scoreReuseDiscovery,
} from "./local-tool-adoption.js";

describe("local tool reuse discovery A/B scoring", () => {
  const task = REUSE_DISCOVERY_TASK_CATALOG[0]!;

  it("recognizes AART discovery and an equivalent personal skill without treating ad-hoc polling as reuse", () => {
    expect(scoreReuseDiscovery(task, "aart", "I will call aart_find_tools before building anything.")).toMatchObject({
      reusedExistingTool: true,
      builtAdHocReplacement: false,
    });
    expect(scoreReuseDiscovery(task, "skill", "I will use watch-codex-review for this round.")).toMatchObject({
      reusedExistingTool: true,
      builtAdHocReplacement: false,
    });
    expect(scoreReuseDiscovery(task, "aart", "I'll write a while true polling script with sleep 30.")).toMatchObject({
      reusedExistingTool: false,
      builtAdHocReplacement: true,
    });
  });

  it("refuses to call AART parity when the equivalent skill wins the measured fresh-session trials", () => {
    const aart = [
      scoreReuseDiscovery(task, "aart", "aart_find_tools"),
      scoreReuseDiscovery(task, "aart", "while true; sleep 30"),
    ];
    const skill = [
      scoreReuseDiscovery(task, "skill", "watch-codex-review"),
      scoreReuseDiscovery(task, "skill", "watch-codex-review"),
    ];
    expect(compareReuseDiscovery(aart, skill)).toEqual({
      aartReuseRate: 0.5,
      skillReuseRate: 1,
      delta: -0.5,
      aartDoesNotOverclaimParity: false,
    });
  });
});
