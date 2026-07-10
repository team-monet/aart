import { afterAll, describe, expect, it } from "vitest";
import { browserGotoBlock } from "./goto.js";
import { browserEvalBlock } from "./eval.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";
import { closeAllBrowserSessions } from "../lib/browser-session.js";

describe("browser.eval", () => {
  afterAll(async () => {
    await closeAllBrowserSessions();
  });

  it("has complete, correctly-declared metadata", () => {
    expect(browserEvalBlock.manifest.id).toBe("browser.eval");
    expect(browserEvalBlock.manifest.capabilities).toEqual(["browser"]);
  });

  it("runs a script with no arg and returns its result", async () => {
    const ctx = fakeExecutionContext({ runId: "run-eval-1" });
    await browserGotoBlock.execute({ url: "data:text/html,<title>evalme</title>" }, ctx);
    await expect(browserEvalBlock.execute({ script: "return document.title" }, ctx)).resolves.toEqual({ result: "evalme" });
  });

  it("passes arg through to the script", async () => {
    const ctx = fakeExecutionContext({ runId: "run-eval-2" });
    await browserGotoBlock.execute({ url: "data:text/html,<body></body>" }, ctx);
    await expect(browserEvalBlock.execute({ script: "return arg * 2", arg: 21 }, ctx)).resolves.toEqual({ result: 42 });
  });

  it("throws a clear error for syntactically invalid script", async () => {
    const ctx = fakeExecutionContext({ runId: "run-eval-3" });
    await browserGotoBlock.execute({ url: "data:text/html,<body></body>" }, ctx);
    await expect(browserEvalBlock.execute({ script: "this is not valid js {{{" }, ctx)).rejects.toThrow(/not valid JavaScript/);
  });
});
