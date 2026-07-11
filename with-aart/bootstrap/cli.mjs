#!/usr/bin/env node
/**
 * with-aart is installed AGENT-FIRST — you don't run a script, your coding agent does
 * the install by following bootstrap/install.md. This command just prints the one line to
 * paste into your agent (handy if you found this directory while browsing the repo and
 * aren't sure where to start).
 */
const line =
  "Set up AART for me: read https://raw.githubusercontent.com/team-monet/aart/main/with-aart/bootstrap/install.md and follow it, checking with me at each decision point.";
console.log("with-aart — agent-first AART onboarding\n");
console.log("You don't run an installer. Open your coding agent and paste this one line:\n");
console.log(`  ${line}\n`);
console.log("The agent then follows bootstrap/install.md: orient -> get AART -> wire this");
console.log("workspace's MCP config -> offer the global working-instructions install -> verify.");
