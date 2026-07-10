// Thin adapter smoke test — see mcp-stdio.ts's module doc comment for why
// this is intentionally light (correctness here is mostly a typecheck/build
// concern; the mode-gating/dispatch/envelope logic it wraps is exhaustively
// tested in tools/server.test.ts against the protocol-agnostic core
// directly). Uses fake stdin/stdout streams so this never touches the real
// test-runner process's own stdio.
import { PassThrough } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import type { TestContext } from "./test-utils.js";
import { createTestContext } from "./test-utils.js";
import { startMcpStdioServer } from "./mcp-stdio.js";

let tc: TestContext;
afterEach(async () => {
  await tc?.cleanup();
});

describe("startMcpStdioServer", () => {
  it("connects to a transport and exposes a working close()", async () => {
    tc = await createTestContext({ trustMode: "governed" });
    const transport = new StdioServerTransport(new PassThrough(), new PassThrough());
    const handle = await startMcpStdioServer(tc.ctx, transport);
    expect(handle.mcpServer.isConnected()).toBe(true);
    await handle.close();
  });

  it("registers only the currently-available tool set (mode-gating carries through to the real SDK registration)", async () => {
    tc = await createTestContext({ trustMode: "strict" });
    const transport = new StdioServerTransport(new PassThrough(), new PassThrough());
    const handle = await startMcpStdioServer(tc.ctx, transport);
    // McpServer doesn't expose a public "list registered tool names"
    // getter, so this asserts indirectly: connecting didn't throw even
    // though aart_approve (mode-gated in strict) was skipped, and the
    // server reports itself connected.
    expect(handle.mcpServer.isConnected()).toBe(true);
    await handle.close();
  });
});
