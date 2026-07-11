// @testing-library/react's automatic afterEach(cleanup) registration only
// fires when it detects a global `afterEach` (e.g. Jest's globals, or
// vitest's own `test.globals: true`). This workspace deliberately doesn't
// enable vitest globals anywhere else (every other package imports
// describe/it/expect explicitly from "vitest" — see any *.test.ts here),
// so cleanup is wired explicitly instead: without it, a component rendered
// in one test stays mounted into the shared jsdom `document` and leaks into
// the next test's queries (duplicate-element failures that only show up
// when tests run in the same file/process, not in isolation — exactly the
// kind of flake this repo's own testing conventions try to avoid).
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
  // Every page test stubs global.fetch per-test (test-support/mock-fetch.ts)
  // — unstub here so one test's fetch mock can never leak into the next.
  vi.unstubAllGlobals();
});
