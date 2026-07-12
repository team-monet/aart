// aart environment register/list — ADR-2 (D1 "remotes + push", ratified,
// AMENDMENTS.md A56). Wires the previously-dead `registerEnvironment`
// (`@aart/server`) to a real CLI command — without it there was no legal
// CLI way to create a production-trust `Environment` at all (the only prior
// path, `aart_deploy_workflow`'s own `ensureEnvironment`, always creates an
// EMPTY config with no `trustMode` set, silently defaulting to "governed"
// per `requiredGatesForEnvironment`'s own convention — never a documented
// way to get a `dev`/`strict`/`production`-trust environment onto a store).
//
// Direct store access, same as every OTHER CLI command (`aart deploy`,
// `aart register`, ...) — NOT routed through the HTTP `POST /environments`
// this session also builds (`packages/server/src/http/server.ts`). That
// route exists for a genuinely different scenario this command doesn't
// address: an operator with only NETWORK access to a remote server (no
// filesystem access to its store), the same "no shell on the target"
// situation `aart push`/`aart_deploy` themselves target. This command is
// for the ordinary case — a shell with `--root`/`AART_ROOT` pointed at the
// store (local dev, or a shared-mount production deployment) — where every
// other CLI command already talks to the store directly, no HTTP round
// trip to itself needed.
import { registerEnvironment } from "@aart/server";
import type { HandlerResult } from "@aart/mcp";
import type { Tokenized } from "../args.js";
import { flagString, requirePositional } from "../args.js";
import type { CliContext } from "../cli-context.js";

const VALID_TRUST_MODES = ["dev", "governed", "strict", "production"] as const;
type ValidTrustMode = (typeof VALID_TRUST_MODES)[number];

function isValidTrustMode(value: string): value is ValidTrustMode {
  return (VALID_TRUST_MODES as readonly string[]).includes(value);
}

export async function environmentRegisterCommand(tokens: Tokenized, cli: CliContext): Promise<HandlerResult> {
  const name = requirePositional(tokens.positionals, 0, "name");
  const trustModeFlag = flagString(tokens.flags, "trust-mode");
  if (trustModeFlag !== undefined && !isValidTrustMode(trustModeFlag)) {
    return { ok: false, error: `--trust-mode must be one of: ${VALID_TRUST_MODES.join(", ")} (got "${trustModeFlag}").` };
  }
  const environment = await registerEnvironment(cli.aart.store, { name, trustMode: trustModeFlag });
  return { ok: true, environment };
}

export async function environmentListCommand(cli: CliContext): Promise<HandlerResult> {
  const environments = await cli.aart.store.environments.list();
  return { ok: true, environments };
}

export async function environmentCommand(tokens: Tokenized, cli: CliContext): Promise<HandlerResult> {
  const [subcommand, ...rest] = tokens.positionals;
  if (subcommand === "register") return environmentRegisterCommand({ positionals: rest, flags: tokens.flags }, cli);
  if (subcommand === "list") return environmentListCommand(cli);
  return { ok: false, error: "Usage: aart environment register <name> --trust-mode <dev|governed|strict|production> | aart environment list" };
}
