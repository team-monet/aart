#!/usr/bin/env node
// Platform smoke test — headless browser (implementation plan §2/§6 Risk 3
// mitigation): launches a headless Chromium via Playwright and confirms it
// can actually navigate and read page content. This is deliberately run as
// an early, explicit CI step, before any Wave-1 session's real tests depend
// on Playwright working — the whole point is surfacing install/platform
// friction at the foundation layer, not silently working around it.
//
// Plain .mjs (not TypeScript) and runnable with plain `node`, deliberately
// — a smoke test that itself depends on the workspace's build/typecheck
// pipeline succeeding first would defeat the purpose of running it as an
// EARLY step.
import { chromium } from "playwright";

async function main() {
  console.log("[smoke:browser] launching headless chromium...");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent("<html><body><h1 id='target'>aart-smoke-ok</h1></body></html>");
    const text = await page.textContent("#target");
    if (text !== "aart-smoke-ok") {
      throw new Error(`expected page text "aart-smoke-ok", got ${JSON.stringify(text)}`);
    }
    console.log("[smoke:browser] OK — launched, navigated, and read page content successfully.");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("[smoke:browser] FAILED —", err);
  process.exitCode = 1;
});
