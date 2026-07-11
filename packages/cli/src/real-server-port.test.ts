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
import { afterEach, describe, expect, it } from "vitest";
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
