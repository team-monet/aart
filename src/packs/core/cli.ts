/**
 * Governed CLI command blocks shipped with the core pack.
 *
 * All blocks here have execution.type === 'command'. They are delivered via
 * corePack.commands[] and stamped approval:'approved' at load time by the
 * registry — trusted by origin (pack-shipped), exactly like native blocks and
 * pack workflows.
 *
 * Safety properties common to every block here:
 *   - command binary is a FIXED string (no interpolation)
 *   - args are an argv TEMPLATE spawned WITHOUT a shell — injection-shaped
 *     inputs land as literal arguments, never second commands
 *   - inputs are constrained by enum and/or pattern so only valid, safe values
 *     reach the subprocess
 *   - all operations are READ-ONLY (no state mutation, no writes)
 *   - every execution is captured in run history with full stdout/stderr/exitCode
 */

import type { BlockDefinition } from '../../core/types'

// ---------------------------------------------------------------------------
// Output shape (matches CommandResult.output from src/core/command-runner.ts)
// ---------------------------------------------------------------------------
//
// The command-runner resolves to:
//   { stdout: string, stderr: string, exitCode: number, ok: boolean, truncated: boolean }
// (command-runner.ts lines 110-117)
//
// All blocks below declare the same output fields.

const commandOutputs: BlockDefinition['outputs'] = [
  { name: 'stdout', type: 'string', description: 'Raw standard output from the command.' },
  { name: 'stderr', type: 'string', description: 'Raw standard error from the command.' },
  { name: 'exitCode', type: 'number', description: 'Process exit code (0 = success).' },
  { name: 'ok', type: 'boolean', description: 'True when exitCode === 0.' },
  { name: 'truncated', type: 'boolean', description: 'True if stdout or stderr was truncated at the 200 kB limit.' },
]

// ---------------------------------------------------------------------------
// git blocks
// ---------------------------------------------------------------------------

export const gitStatus: BlockDefinition = {
  id: 'git.status',
  name: 'Git Status (porcelain)',
  version: '0.1.0',
  description: 'Run `git status --porcelain` and return the short-format working-tree status.',
  category: 'git',
  keywords: ['git', 'status', 'working tree', 'changes', 'dirty', 'modified', 'staged'],
  inputs: [],
  outputs: commandOutputs,
  examples: [
    {
      description: 'Check for uncommitted changes before a deploy',
      inputs: {},
    },
  ],
  execution: {
    type: 'command',
    command: 'git',
    // -c core.fsmonitor=false: prevent fsmonitor hook execution.
    // --no-optional-locks: skip optional index-lock writes (read-only intent).
    // Global options must precede the subcommand.
    args: ['-c', 'core.fsmonitor=false', '--no-optional-locks', 'status', '--porcelain'],
  },
}

export const gitCurrentBranch: BlockDefinition = {
  id: 'git.current-branch',
  name: 'Git Current Branch',
  version: '0.1.0',
  description:
    'Return the name of the currently checked-out Git branch using `symbolic-ref`. ' +
    'In detached-HEAD mode (common in CI) exits non-zero and ok is false rather than ' +
    'falsely reporting "HEAD" as a branch name.',
  category: 'git',
  keywords: ['git', 'branch', 'current', 'head', 'ref', 'symbolic-ref', 'detached'],
  inputs: [],
  outputs: commandOutputs,
  examples: [
    {
      description: 'Read the active branch name',
      inputs: {},
    },
  ],
  execution: {
    type: 'command',
    command: 'git',
    // symbolic-ref yields the real branch name or exits non-zero on detached HEAD.
    // -c core.fsmonitor=false: no hook execution.
    // -q: suppress the "fatal: …" message on detached HEAD.
    // failOnError:false so detached HEAD → ok:false / empty stdout instead of throw.
    args: ['-c', 'core.fsmonitor=false', 'symbolic-ref', '-q', '--short', 'HEAD'],
    failOnError: false,
  },
}

export const gitLog: BlockDefinition = {
  id: 'git.log',
  name: 'Git Log (oneline)',
  version: '0.1.0',
  description: 'Return the last N commits in `--oneline` format. `count` must be a positive integer.',
  category: 'git',
  keywords: ['git', 'log', 'commits', 'history', 'changelog'],
  inputs: [
    {
      name: 'count',
      type: 'number',
      description: 'Number of commits to show (default 10). Must be a positive integer (no leading zero).',
      required: false,
      default: 10,
      // Positive integer only — rejects 0, negatives, floats, and leading zeros.
      // The engine applies this against String(value) so numeric inputs are covered.
      pattern: '^[1-9][0-9]*$',
    },
  ],
  outputs: commandOutputs,
  examples: [
    {
      description: 'Show the last 5 commits',
      inputs: { count: 5 },
    },
  ],
  execution: {
    type: 'command',
    command: 'git',
    // -c core.fsmonitor=false: no hook execution.
    // --no-optional-locks: no index-lock writes.
    // Global options before the subcommand.
    args: ['-c', 'core.fsmonitor=false', '--no-optional-locks', 'log', '-n', '{{inputs.count}}', '--oneline'],
  },
}

export const gitDiff: BlockDefinition = {
  id: 'git.diff',
  name: 'Git Diff Stat',
  version: '0.1.0',
  description:
    'Return a `--stat` summary of working-tree changes (unstaged). ' +
    'Ref support (e.g. HEAD~1..HEAD) is a future enhancement — optional argv slots ' +
    'are awkward without a shell, so args are fixed for v1.',
  category: 'git',
  keywords: ['git', 'diff', 'stat', 'changes', 'delta', 'files changed'],
  inputs: [],
  outputs: commandOutputs,
  examples: [
    {
      description: 'Summarise unstaged working-tree changes',
      inputs: {},
    },
  ],
  execution: {
    type: 'command',
    command: 'git',
    // -c core.fsmonitor=false: no hook execution.
    // --no-optional-locks: no index-lock writes.
    // --no-textconv: no external textconv converters.
    // --no-ext-diff: no external diff drivers.
    args: ['-c', 'core.fsmonitor=false', '--no-optional-locks', 'diff', '--stat', '--no-textconv', '--no-ext-diff'],
  },
}

// ---------------------------------------------------------------------------
// kubectl blocks
// ---------------------------------------------------------------------------

export const kubectlGet: BlockDefinition = {
  id: 'kubectl.get',
  name: 'Kubectl Get (JSON)',
  version: '0.1.0',
  description:
    'Run `kubectl get <resource> -n <namespace> -o json` and return the raw JSON output. ' +
    'The `resource` input is constrained to a safe enum so only read-only, known resource types ' +
    'are accepted. The `namespace` pattern `^[a-z0-9-]+$` allows any valid Kubernetes namespace ' +
    'name — a fork can tighten this to an enum like ["dev","staging"] so the block cannot target ' +
    'prod regardless of what calls it.',
  category: 'k8s',
  keywords: ['kubernetes', 'kubectl', 'k8s', 'pods', 'deployments', 'services', 'nodes', 'get', 'inspect'],
  inputs: [
    {
      name: 'resource',
      type: 'string',
      description: 'Kubernetes resource type to list.',
      required: true,
      enum: ['pods', 'deployments', 'services', 'nodes', 'configmaps', 'events'],
    },
    {
      name: 'namespace',
      type: 'string',
      description:
        'Target namespace. Pattern restricts to valid k8s namespace characters; ' +
        'first char must be alphanumeric (no leading `-`). ' +
        'Override with an enum (e.g. ["dev","staging"]) in a fork to prevent prod targeting.',
      required: false,
      default: 'default',
      // First char alphanumeric (no leading `-` which could be flag-shaped).
      pattern: '^[a-z0-9][a-z0-9-]*$',
    },
  ],
  outputs: commandOutputs,
  examples: [
    {
      description: 'List all pods in the staging namespace',
      inputs: { resource: 'pods', namespace: 'staging' },
    },
  ],
  execution: {
    type: 'command',
    command: 'kubectl',
    args: ['get', '{{inputs.resource}}', '-n', '{{inputs.namespace}}', '-o', 'json'],
  },
}

// ---------------------------------------------------------------------------
// docker blocks
// ---------------------------------------------------------------------------

export const dockerPs: BlockDefinition = {
  id: 'docker.ps',
  name: 'Docker PS (JSON)',
  version: '0.1.0',
  description:
    'List running Docker containers in JSON format (`docker ps --format json`). ' +
    'Uses `--format json` rather than Go-template syntax to avoid aart resolver ' +
    'interpreting `{{.Names}}` as an interpolation expression.',
  category: 'docker',
  keywords: ['docker', 'containers', 'ps', 'list', 'running', 'inspect'],
  inputs: [],
  outputs: commandOutputs,
  examples: [
    {
      description: 'List all running containers',
      inputs: {},
    },
  ],
  execution: {
    type: 'command',
    command: 'docker',
    // IMPORTANT: do NOT use Go-template formats like {{.Names}} here — aart's
    // resolver would try to interpolate {{.Names}} and throw. Use `json` instead.
    args: ['ps', '--format', 'json'],
  },
}

// ---------------------------------------------------------------------------
// GitHub CLI blocks
// ---------------------------------------------------------------------------

export const ghApi: BlockDefinition = {
  id: 'gh.api',
  name: 'GitHub API (GET)',
  version: '0.1.0',
  description:
    'Call the GitHub REST API at the given path using `gh api` (GET only in v1). ' +
    'The `endpoint` pattern restricts to safe path characters so query injection is ' +
    'not possible even without a shell. ' +
    'Auth options (in precedence order): ' +
    '(1) set AART_SECRET_GH_TOKEN to your token — it is injected as GH_TOKEN and ' +
    'redacted from run reports; ' +
    '(2) run `gh auth login` on the host — gh reads ~/.config/gh (HOME is in the ' +
    'command-runner env whitelist) with no token env var needed. ' +
    'CI note: if your pipeline only exposes GITHUB_TOKEN in the environment (not via ' +
    'gh auth login), set AART_SECRET_GH_TOKEN=$GITHUB_TOKEN so the token is declared ' +
    'and redacted rather than leaked unmasked into run reports.',
  category: 'github',
  keywords: ['github', 'gh', 'api', 'rest', 'repos', 'pulls', 'issues', 'releases'],
  inputs: [
    {
      name: 'endpoint',
      type: 'string',
      description:
        'REST API path, e.g. "repos/owner/repo/pulls". ' +
        'Pattern allows alphanumerics, /, ., -, _ only (no method override).',
      required: true,
      // Read-only GET path — first char must be alphanumeric (no leading `-`)
      // to prevent flag-shaped values; remaining chars are safe URL path characters.
      // No leading slash required; gh api accepts bare paths.
      pattern: '^[A-Za-z0-9][A-Za-z0-9/_.-]*$',
    },
  ],
  outputs: commandOutputs,
  examples: [
    {
      description: 'List open pull requests for a repository',
      inputs: { endpoint: 'repos/owner/repo/pulls' },
    },
  ],
  execution: {
    type: 'command',
    command: 'gh',
    args: ['api', '{{inputs.endpoint}}'],
    // Secret keys are always lowercased by loadSecrets (AART_SECRET_GH_TOKEN → gh_token).
    // When gh_token is unset, the command-runner omits GH_TOKEN from the child env
    // and gh falls back to ~/.config/gh (set by `gh auth login`; HOME is whitelisted).
    env: { GH_TOKEN: '{{secrets.gh_token}}' },
  },
}

// ---------------------------------------------------------------------------
// Exported array (wired into corePack.commands)
// ---------------------------------------------------------------------------

export const cliCommands: BlockDefinition[] = [
  gitStatus,
  gitCurrentBranch,
  gitLog,
  gitDiff,
  kubectlGet,
  dockerPs,
  ghApi,
]
