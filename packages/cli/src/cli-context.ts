// The CLI's composition root — wraps @aart/mcp's shared createAartContext
// (so `aart run`/`aart validate`/etc. dispatch through the exact same
// handler functions aart_run_workflow/aart_validate/etc. do) plus the
// CLI-only StubServerPort (worker/server/bundle/flag — architecture §13.3's
// stated exception, never exposed via MCP).
import { createAartContext, type AartContext, type CreateAartContextOptions, type ServerPort } from "@aart/mcp";
import { createStubServerPort } from "./stubs/server.js";

export interface CliContext {
  aart: AartContext;
  serverPort: ServerPort;
}

export function createCliContext(options?: CreateAartContextOptions): CliContext {
  const aart = createAartContext(options);
  const serverPort = createStubServerPort(aart.store);
  return { aart, serverPort };
}
