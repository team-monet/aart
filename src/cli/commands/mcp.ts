import { startMcpServer } from '../../mcp/server'

/** `aart mcp` — start the MCP server (stdio) so a coding agent can drive aart. */
export async function mcpCommand(): Promise<void> {
  await startMcpServer()
}
