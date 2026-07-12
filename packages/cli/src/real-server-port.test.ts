// createRealServerPort's secretResolver wiring, end to end through a real
// HTTP webhook delivery (AMENDMENTS.md A45 — the exact gap A44 found:
// "aart server's real ServerPort never wires a secretResolver... no
// HTTP-delivered trigger can currently fire successfully through the
// shipping aart server"). Exercises the SAME composition root `aart server`
// itself uses (createCliContext -> createRealServerPort -> secrets.ts),
// not a hand-assembled stand-in — a permanent regression test alongside
// TEST-DRIVE.md's founder-facing live walkthrough (which is the actual
// installed-binary + curl proof; this is the fast, always-run CI guard for
// the same wiring).
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileWorkflowInput } from "@aart/mcp";
import { computeHmacSignature } from "@aart/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCliContext, type CliContext } from "./cli-context.js";

function probeWorkflow(id: string) {
  return {
    id,
    name: "Webhook Secret Wiring Probe (real-server-port.test.ts)",
    version: "0.1.0",
    steps: [{ id: "greet", uses: "data.stringify", with: { value: "hello", format: "json" } }],
  };
}

let cleanupPaths: string[] = [];
let handleClose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await handleClose?.();
  handleClose = undefined;
  delete process.env.AART_SECRET_PROBE_SECRET;
  delete process.env.AART_DEPLOY_TOKEN;
  delete process.env.AART_DEPLOY_TOKEN_NEXT;
  await Promise.all(cleanupPaths.map((p) => fs.rm(p, { recursive: true, force: true })));
  cleanupPaths = [];
});

async function freshCli(): Promise<CliContext> {
  const base = await fs.mkdtemp(join(tmpdir(), "aart-real-server-port-test-"));
  cleanupPaths.push(base);
  return createCliContext({ root: join(base, ".aart"), trustMode: "governed" });
}

describe("createRealServerPort — real secretResolver wiring (AMENDMENTS.md A45)", () => {
  it("a correctly-signed webhook delivery verifies against AART_SECRET_<NAME> and starts a real run; a bad signature is rejected 401 with a persisted rejected-trigger record", async () => {
    const cli = await freshCli();
    const workflow = compileWorkflowInput(probeWorkflow("wf-webhook-secret-probe"));
    await cli.aart.store.workflows.put(workflow);
    await cli.aart.store.deployments.put({
      id: "binding_secret_probe",
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      environmentId: "env_probe",
      triggerConfig: { type: "webhook", webhookPath: "/webhooks/binding_secret_probe", webhookHmacSecretRef: "secrets.PROBE_SECRET" },
      createdAt: new Date().toISOString(),
    });
    process.env.AART_SECRET_PROBE_SECRET = "real-wired-secret";

    const handle = await cli.serverPort.startServer({ port: 0 });
    handleClose = () => handle.close();

    const payload = { hello: "world" };
    const rawBody = JSON.stringify(payload);
    const goodSig = computeHmacSignature(new TextEncoder().encode(rawBody), "real-wired-secret");
    const okRes = await fetch(`http://localhost:${handle.port}/webhooks/binding_secret_probe`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-aart-signature": goodSig },
      body: rawBody,
    });
    expect(okRes.status).toBe(200);
    const okBody = (await okRes.json()) as { kind: string; runId: string };
    expect(okBody.kind).toBe("started");
    // Proves real trigger intake (secret verified, engine.startRun actually
    // invoked with this delivery's real inputs) — not full run completion,
    // which depends on a worker claiming the job_queue entry (none is
    // started in this test; that's a separate concern from secret wiring).
    await expect(cli.aart.store.runs.get(okBody.runId)).resolves.toMatchObject({ workflowId: workflow.id, workflowVersion: workflow.version });

    const badRes = await fetch(`http://localhost:${handle.port}/webhooks/binding_secret_probe`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-aart-signature": "sha256=0000000000000000000000000000000000000000000000000000000000000" },
      body: rawBody,
    });
    expect(badRes.status).toBe(401);
    const rejected = await cli.aart.store.rejectedTriggers.list({ reason: "bad_hmac" });
    expect(rejected.length).toBe(1);
  });

  it("with no AART_SECRET_<NAME> configured (and no secrets.json), even a correctly-formed signature is rejected — an unconfigured secret must fail closed, not fall back to unverified", async () => {
    const cli = await freshCli();
    const workflow = compileWorkflowInput(probeWorkflow("wf-webhook-secret-unconfigured"));
    await cli.aart.store.workflows.put(workflow);
    await cli.aart.store.deployments.put({
      id: "binding_unconfigured",
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      environmentId: "env_probe",
      triggerConfig: { type: "webhook", webhookPath: "/webhooks/binding_unconfigured", webhookHmacSecretRef: "secrets.NEVER_SET" },
      createdAt: new Date().toISOString(),
    });

    const handle = await cli.serverPort.startServer({ port: 0 });
    handleClose = () => handle.close();

    const rawBody = JSON.stringify({ hello: "world" });
    // Signed against a guessed/empty secret — with nothing configured for
    // NEVER_SET, the resolver returns undefined, hmac.ts's own
    // `!secret -> false` makes this an automatic reject regardless of what
    // the caller signs with.
    const sig = computeHmacSignature(new TextEncoder().encode(rawBody), "whatever-an-attacker-might-guess");
    const res = await fetch(`http://localhost:${handle.port}/webhooks/binding_unconfigured`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-aart-signature": sig },
      body: rawBody,
    });
    expect(res.status).toBe(401);
  });
});

// D1 "remotes + push" fix pass (AMENDMENTS.md A57) — the exact gap this
// session's own review found: A56 built resolveDeployToken (secrets.ts) and
// the entire deploy-token gate (/bundles/ingest, /bundles/plan,
// /environments — @aart/server's http/server.ts), but createRealServerPort's
// startServer never called it, so ServerConfig.deployToken was always
// undefined and those three routes refused EVERY request — including a
// correctly-token'd one — through a real `aart server`. Same class of bug
// as A45 above (a composition-root wiring gap — the resolver/mechanism was
// real and unit-tested, but the ONE real production caller never threaded
// it through) and, per this fix pass's own root-cause note, the THIRD
// occurrence of this exact bug class in this repo (A48, A53, now this) — a
// from-the-CLI-entry test through the SAME composition root `aart server`
// itself uses is exactly what closes it, mirroring the A45 pattern above
// rather than only unit-testing resolveDeployToken in isolation (secrets.ts
// already does that).
describe("createRealServerPort — real deployToken wiring (AMENDMENTS.md A57 fix pass)", () => {
  it("a correct Bearer token reaches past the deploy-token gate (envelope validation, never the 'not configured' 401) through a real aart server; a wrong token still 401s with the differentiated remedy", async () => {
    process.env.AART_DEPLOY_TOKEN = "real-wired-deploy-token";
    const cli = await freshCli();
    const handle = await cli.serverPort.startServer({ port: 0 });
    handleClose = () => handle.close();

    const okRes = await fetch(`http://localhost:${handle.port}/bundles/plan`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer real-wired-deploy-token" },
      body: JSON.stringify({}), // deliberately missing `files` — proves we got PAST the token gate to requireBundleEnvelope's own 400, not full ingest success
    });
    expect(okRes.status).toBe(400); // requireBundleEnvelope's 400 (bad envelope), never requireDeployToken's 401
    const okBody = (await okRes.json()) as { error: string };
    expect(okBody.error).not.toMatch(/AART_DEPLOY_TOKEN/); // the "not configured" refusal must NOT be what we hit

    const wrongRes = await fetch(`http://localhost:${handle.port}/bundles/plan`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer totally-wrong-token" },
      body: JSON.stringify({}),
    });
    expect(wrongRes.status).toBe(401);
    const wrongBody = (await wrongRes.json()) as { error: string };
    expect(wrongBody.error).toContain('Provide a valid "Authorization: Bearer <token>" header.'); // the DIFFERENTIATED message (deployToken IS configured, just not matched) — never the "no AART_DEPLOY_TOKEN configured" one
  });

  it("with no AART_DEPLOY_TOKEN configured at all, the route still refuses unconditionally (unchanged fail-closed behavior, not a regression from this fix)", async () => {
    const cli = await freshCli();
    const handle = await cli.serverPort.startServer({ port: 0 });
    handleClose = () => handle.close();

    const res = await fetch(`http://localhost:${handle.port}/bundles/plan`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer whatever" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/AART_DEPLOY_TOKEN/);
  });
});

// D2a security hardening, token rotation (AMENDMENTS.md A59) — mirrors the
// A57 deploy-token-wiring describe block immediately above exactly: asserts
// the wiring through the SAME composition root `aart server` itself uses
// (cli.serverPort.startServer), not a hand-built ServerConfig, per this
// sub-phase's own STANDING IMPERATIVE for every new ServerConfig field.
describe("createRealServerPort — real deployTokenNext wiring, token rotation (D2a, AMENDMENTS.md A59)", () => {
  it("the NEXT token is accepted on a conditionally-gated route (promote), same as the primary", async () => {
    process.env.AART_DEPLOY_TOKEN = "primary-token";
    process.env.AART_DEPLOY_TOKEN_NEXT = "next-token";
    const cli = await freshCli();
    const workflow = compileWorkflowInput(probeWorkflow("wf-rotation-next-probe"));
    await cli.aart.store.workflows.put(workflow);
    await cli.aart.store.environments.put({ id: "env_rotation_probe", name: "rotation-probe", config: { trustMode: "dev" } });
    const handle = await cli.serverPort.startServer({ port: 0 });
    handleClose = () => handle.close();

    const res = await fetch(`http://localhost:${handle.port}/workflows/${workflow.id}/promote`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer next-token" },
      body: JSON.stringify({ version: workflow.version, environmentId: "env_rotation_probe" }),
    });
    expect(res.status).toBe(200);
  });

  it("the PRIMARY token is still accepted while a NEXT token is also configured (both valid during a rotation window, on a fail-closed route)", async () => {
    process.env.AART_DEPLOY_TOKEN = "primary-token";
    process.env.AART_DEPLOY_TOKEN_NEXT = "next-token";
    const cli = await freshCli();
    const handle = await cli.serverPort.startServer({ port: 0 });
    handleClose = () => handle.close();

    const res = await fetch(`http://localhost:${handle.port}/bundles/plan`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer primary-token" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400); // past the token gate to requireBundleEnvelope's own 400 -- proves the PRIMARY token still works, not just NEXT
  });

  it("a token matching NEITHER primary nor next is rejected 401", async () => {
    process.env.AART_DEPLOY_TOKEN = "primary-token";
    process.env.AART_DEPLOY_TOKEN_NEXT = "next-token";
    const cli = await freshCli();
    const handle = await cli.serverPort.startServer({ port: 0 });
    handleClose = () => handle.close();

    const res = await fetch(`http://localhost:${handle.port}/bundles/plan`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer totally-unrelated-token" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("with no AART_DEPLOY_TOKEN_NEXT configured at all, behavior is unchanged from before rotation existed (only the primary token works)", async () => {
    process.env.AART_DEPLOY_TOKEN = "primary-token";
    // AART_DEPLOY_TOKEN_NEXT deliberately left unset.
    const cli = await freshCli();
    const handle = await cli.serverPort.startServer({ port: 0 });
    handleClose = () => handle.close();

    const okRes = await fetch(`http://localhost:${handle.port}/bundles/plan`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer primary-token" },
      body: JSON.stringify({}),
    });
    expect(okRes.status).toBe(400); // past the gate

    const rejectedRes = await fetch(`http://localhost:${handle.port}/bundles/plan`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer some-guessed-next-token" },
      body: JSON.stringify({}),
    });
    expect(rejectedRes.status).toBe(401); // no NEXT token configured -- nothing else is valid
  });
});

// D1 fix pass (AMENDMENTS.md A58) — the FOURTH occurrence of the exact same
// composition-root-gap bug class this file's own A45/A57 describe blocks
// above already closed twice (A48, A53 are the other two, elsewhere in this
// repo): @aart/store's createLogger defaults to a silent noopSink
// (architecture §16), and ServerConfig.logSink/WorkerConfig.logSink have
// existed since S2 — but createRealServerPort never passed one through, so
// a real `aart server`'s entire structured-logging surface (including this
// very file's own FIX 1 describe block's tokenless-promote startup warning,
// @aart/server's http/server.ts:232) fired into a sink that discards every
// line, despite DEPLOY.md documenting "structured JSON logs to stdout" as
// the out-of-the-box behavior. Mirrors the A57 deploy-token describe block's
// own discipline immediately above: assert the wiring through the SAME
// composition root `aart server` itself uses, not a hand-built ServerConfig
// (which would only prove consoleJsonSink itself works — already covered by
// @aart/store's own logger.test.ts — not that THIS composition root
// actually passes it through).
describe("createRealServerPort — real logSink wiring (AMENDMENTS.md A58 fix pass)", () => {
  it("a tokenless real aart server's own startup warning is actually observable on the wired console JSON sink — not silently discarded by the default noopSink", async () => {
    const cli = await freshCli();
    // consoleJsonSink (@aart/store's logger.ts) routes warn/error-level
    // lines to console.error, one JSON-stringified line per call — spying
    // on the real global rather than injecting a substitute sink is
    // deliberate: there is no config surface for a caller to override the
    // sink through cli.serverPort.startServer's own public options (`{
    // port?, environment? }, @aart/mcp's ServerPort type) — this IS the
    // only place a break in the wiring would be observable, and the point
    // is to prove this exact, unmodified real path.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // No AART_DEPLOY_TOKEN in env (afterEach deletes it either way) — the
      // tokenless "POST /workflows/:id/promote is UNAUTHENTICATED..."
      // warning (http/server.ts:232) fires exactly once, unconditionally,
      // at startup, regardless of whether any request is ever made.
      const handle = await cli.serverPort.startServer({ port: 0 });
      handleClose = () => handle.close();

      const warningLine = errorSpy.mock.calls.map(([line]) => line as string).find((line) => {
        try {
          const parsed = JSON.parse(line) as { level?: string; msg?: string };
          return parsed.level === "warn" && typeof parsed.msg === "string" && parsed.msg.includes("UNAUTHENTICATED");
        } catch {
          return false;
        }
      });
      expect(warningLine, `expected a warn-level JSON line containing "UNAUTHENTICATED" on console.error; saw: ${JSON.stringify(errorSpy.mock.calls)}`).toBeDefined();
      // Structured, not just "some text landed on stderr" — the exact shape
      // createServerLogger(config.logSink).child({component: "http-server"})
      // (http/server.ts) produces, proving this is genuinely the real
      // shared logger wired all the way through, not a coincidental stray
      // console.error from somewhere else.
      const parsed = JSON.parse(warningLine!) as { level: string; msg: string; service?: string; component?: string; time?: string };
      expect(parsed.level).toBe("warn");
      expect(parsed.service).toBe("@aart/server");
      expect(parsed.component).toBe("http-server");
      expect(typeof parsed.time).toBe("string");
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// D1 "remotes + push" (AMENDMENTS.md A56).
describe("createRealServerPort — produceBundle threads --environment into manifest.targetEnvironment", () => {
  it("a real, registered environment name is threaded through into the produced bundle's manifest", async () => {
    const cli = await freshCli();
    const workflow = compileWorkflowInput(probeWorkflow("wf-target-env-probe"));
    await cli.aart.store.workflows.put(workflow);
    await cli.aart.store.environments.put({ id: "env_prod_probe", name: "production-probe", config: {} });

    const bundle = await cli.serverPort.produceBundle({ workflowId: workflow.id, workflowVersion: workflow.version, environment: "production-probe" });
    expect((bundle.manifest as { targetEnvironment?: string }).targetEnvironment).toBe("production-probe");
  });

  it("omitting --environment leaves the manifest without targetEnvironment at all", async () => {
    const cli = await freshCli();
    const workflow = compileWorkflowInput(probeWorkflow("wf-no-target-env-probe"));
    await cli.aart.store.workflows.put(workflow);

    const bundle = await cli.serverPort.produceBundle({ workflowId: workflow.id, workflowVersion: workflow.version });
    expect(Object.keys(bundle.manifest)).not.toContain("targetEnvironment");
  });

  it("naming an environment that doesn't exist still throws (unchanged pre-D1 behavior) — never silently produces a bundle with a dangling targetEnvironment", async () => {
    const cli = await freshCli();
    const workflow = compileWorkflowInput(probeWorkflow("wf-bad-target-env-probe"));
    await cli.aart.store.workflows.put(workflow);

    await expect(cli.serverPort.produceBundle({ workflowId: workflow.id, workflowVersion: workflow.version, environment: "no-such-environment" })).rejects.toThrow(/not found/);
  });
});

// D2a security hardening, breaking-change bind default (AMENDMENTS.md A59)
// — the MANDATORY composition-root test this sub-phase's own brief calls
// for: through `cli.serverPort.startServer` (the createCliContext ->
// createRealServerPort path), not a hand-built ServerConfig, asserting the
// default bind is loopback and an explicit host is honored. `ServerHandleLike`
// (the PUBLIC type `cli.serverPort.startServer` is declared to return,
// `@aart/mcp`'s types.ts) only exposes `{port, close()}` — `createRealServerPort`'s
// own implementation returns the REAL `@aart/server` `ServerHandle` object
// UNMODIFIED (real-server-port.ts: `return startRealServer({...});`), which
// carries a genuine `.server: node:http.Server` at runtime even though the
// declared TS type doesn't name it — the same trick this file's own A58
// describe block above uses (spying on the real console rather than
// injecting a substitute, because there's no public config seam to do
// otherwise through). Captured here via an explicit cast, matching that
// established precedent for "this IS the only place a break in the wiring
// would be observable."
describe("createRealServerPort — host binding (D2a security hardening, AMENDMENTS.md A59)", () => {
  function boundAddress(handle: { close(): Promise<void> }): string | undefined {
    const server = (handle as unknown as { server: import("node:net").Server }).server;
    const address = server.address();
    return typeof address === "object" && address ? address.address : undefined;
  }

  it("defaults to loopback-only (127.0.0.1), not every interface, through the real CLI entry", async () => {
    const cli = await freshCli();
    const handle = await cli.serverPort.startServer({ port: 0 });
    handleClose = () => handle.close();
    expect(boundAddress(handle)).toBe("127.0.0.1");
  });

  it("an explicit host is honored through the real CLI entry", async () => {
    const cli = await freshCli();
    const handle = await cli.serverPort.startServer({ port: 0, host: "0.0.0.0" });
    handleClose = () => handle.close();
    expect(boundAddress(handle)).toBe("0.0.0.0");
  });
});

// D2a fix pass (AMENDMENTS.md A60, FIX 3) — `aart server` had no
// "listening" log line at all: the bind was mechanically silent, so an
// operator couldn't tell a loopback-only bind from an all-interfaces one at
// the moment it mattered — only discoverable later, via a failed remote
// connection attempt. Mirrors the A58 logSink-wiring describe block above
// exactly: spies on the real console.log global (consoleJsonSink routes
// info-level lines there, @aart/store's logger.ts) through the SAME real
// composition root (cli.serverPort.startServer) — there is still no public
// config seam to inject a substitute sink through ServerPort's own
// {port?, environment?, host?} surface, so this remains the only place a
// break in the wiring would be observable.
describe("createRealServerPort — startup listening log line (D2a fix pass, AMENDMENTS.md A60, FIX 3)", () => {
  function findListeningLine(calls: unknown[][]): { level: string; msg: string; host?: string; port?: number; service?: string; component?: string } | undefined {
    const raw = calls.map((call) => call[0] as string).find((entry) => {
      try {
        const parsed = JSON.parse(entry) as { level?: string; msg?: string };
        return parsed.level === "info" && parsed.msg === "aart server listening";
      } catch {
        return false;
      }
    });
    return raw ? (JSON.parse(raw) as { level: string; msg: string; host?: string; port?: number; service?: string; component?: string }) : undefined;
  }

  it("logs a structured 'aart server listening' line with the resolved (default loopback) host and the real bound port, after server.listen's callback fires", async () => {
    const cli = await freshCli();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const handle = await cli.serverPort.startServer({ port: 0 });
      handleClose = () => handle.close();

      const parsed = findListeningLine(logSpy.mock.calls);
      expect(parsed, `expected an info-level JSON line with msg "aart server listening" on console.log; saw: ${JSON.stringify(logSpy.mock.calls)}`).toBeDefined();
      expect(parsed!.host).toBe("127.0.0.1"); // default loopback bind (AMENDMENTS.md A59) — not the port-0-request, the ACTUAL resolved host
      expect(parsed!.port).toBe(handle.port); // the REAL bound port, not the port:0 request that asked for "any free port"
      expect(parsed!.service).toBe("@aart/server");
      expect(parsed!.component).toBe("http-server");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("an explicit host is reflected in the listening log line too", async () => {
    const cli = await freshCli();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const handle = await cli.serverPort.startServer({ port: 0, host: "0.0.0.0" });
      handleClose = () => handle.close();

      const parsed = findListeningLine(logSpy.mock.calls);
      expect(parsed).toBeDefined();
      expect(parsed!.host).toBe("0.0.0.0");
    } finally {
      logSpy.mockRestore();
    }
  });
});
