export type RunTerminalHook = (
  runId: string,
) => void | Promise<void>;

/**
 * Terminal observers run only after the RunRecord transition commits.
 * Their failures are best-effort operational failures and never roll back
 * the already-durable customer state.
 */
export async function notifyRunTerminal(
  hook: RunTerminalHook | undefined,
  runId: string,
): Promise<void> {
  if (!hook) return;
  try {
    await hook(runId);
  } catch {
    // The terminal state is already durable. Event/resource observers can
    // retry independently and must not rewrite the run outcome.
  }
}

export async function notifyRunTerminals(
  hook: RunTerminalHook | undefined,
  runIds: ReadonlySet<string>,
): Promise<void> {
  for (const runId of runIds) {
    await notifyRunTerminal(hook, runId);
  }
}
