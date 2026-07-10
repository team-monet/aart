import { describe, expect, it } from "vitest";
import { renderDeploymentsPage, renderEnvironmentsPage, renderSecretsStatusPage, renderTriggerConfigsPage, renderWorkerHealthPage } from "./production.js";

describe("renderEnvironmentsPage / renderDeploymentsPage", () => {
  it("renders environments and deployments", () => {
    expect(renderEnvironmentsPage([{ id: "env-1", name: "staging", config: {} }])).toContain("staging");
    expect(renderDeploymentsPage([{ id: "dep-1", workflowId: "wf-1", workflowVersion: "1.0.0", environmentId: "env-1", triggerConfig: {}, createdAt: "t" }])).toContain("dep-1");
  });
});

describe("renderTriggerConfigsPage", () => {
  it("only shows deployments with a non-empty triggerConfig", () => {
    const html = renderTriggerConfigsPage([
      { id: "dep-1", workflowId: "wf-1", workflowVersion: "1.0.0", environmentId: "env-1", triggerConfig: { cron: "0 * * * *" }, createdAt: "t" },
      { id: "dep-2", workflowId: "wf-2", workflowVersion: "1.0.0", environmentId: "env-1", triggerConfig: {}, createdAt: "t" },
    ]);
    expect(html).toContain("dep-1");
    expect(html).not.toContain("dep-2");
  });
});

describe("renderSecretsStatusPage — values never shown", () => {
  it("renders secret NAMES and a bound status, never the underlying adapter config value", () => {
    const html = renderSecretsStatusPage([{ id: "env-1", name: "prod", config: {}, secretSource: { GITHUB_TOKEN: { vault: "prod-vault", path: "/secret/github-super-value-12345" } } }]);
    expect(html).toContain("GITHUB_TOKEN");
    expect(html).toContain("bound");
    expect(html).not.toContain("super-value-12345");
    expect(html).not.toContain("prod-vault");
  });

  it("renders '(none configured)' for an environment with no secretSource", () => {
    expect(renderSecretsStatusPage([{ id: "env-1", name: "dev", config: {} }])).toContain("none configured");
  });
});

describe("renderWorkerHealthPage", () => {
  it("renders a healthy worker's payload fields", () => {
    const html = renderWorkerHealthPage([{ url: "http://worker-1:8787", health: { status: "ok", claimedRuns: 3, uptime: 120, version: "0.1.0" } }]);
    expect(html).toContain("worker-1");
    expect(html).toContain("120s");
  });

  it("renders an unreachable worker distinctly", () => {
    const html = renderWorkerHealthPage([{ url: "http://worker-2:8787", health: { error: "ECONNREFUSED" } }]);
    expect(html).toContain("unreachable");
    expect(html).toContain("ECONNREFUSED");
  });
});
