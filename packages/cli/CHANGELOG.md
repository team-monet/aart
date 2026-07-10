# @team-monet/aart

## 0.1.0

### Minor Changes

- Initial public release of the AART governed workflow runtime CLI.

  This release merges all eight Wave-1 build sessions (engine, server,
  blocks-core, governance, MCP tool surface, evidence/evals, registry,
  LLM pack) plus the S9 integration/hardening pass: real end-to-end
  composition root wiring, a critical redaction-mechanism fix (resolved
  secret values, not names, are now correctly scrubbed from every
  persisted record), real capability/governance/evidence wiring, the
  redacted-legacy-b and redacted-legacy-a flagship example workflows with passing
  end-to-end tests (including a genuine process-kill-and-restart proof of
  the durable wait/resume machine), and an adversarial security pass over
  redaction and the isolated-vm sandbox boundary.
