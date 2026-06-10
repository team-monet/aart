#!/usr/bin/env node
import { Command } from 'commander'
import { runCommand } from './commands/run'
import { addCommand, listCommand } from './commands/block'
import { reportCommand } from './commands/report'
import { contextCommand } from './commands/context'
import { schemaCommand } from './commands/schema'
import { validateCommand } from './commands/validate'
import { mcpCommand } from './commands/mcp'
import { approveCommand, deprecateCommand, showCommand } from './commands/approve'
import { packApproveCommand, packListCommand, packRegisterCommand } from './commands/pack'
import { doctorCommand } from './commands/doctor'
import { setWorkspace } from './workspace'

const program = new Command()

program
  .name('aart')
  .description('Agentic Automation RunTime — a governed block/workflow runtime for AI agents')
  .version('0.4.0')
  .option('-w, --workspace <dir>', 'workspace directory (default: $AART_WORKSPACE or cwd)')
  .hook('preAction', () => {
    const ws = program.opts().workspace
    if (ws) setWorkspace(ws)
  })

program
  .command('run')
  .argument('<workflow>', 'workflow id in the registry, or a path to a .yaml file')
  .option('-i, --input <json>', 'inputs as a JSON object', '{}')
  .option('-p, --param <json>', 'params as a JSON object', '{}')
  .option('--yes', 'approve this one run of an unapproved definition (user override)', false)
  .option('--verbose', 'print block logs', false)
  .description('run a workflow and write a structured run report')
  .action(runCommand)

const block = program
  .command('block')
  .description('manage blocks & workflows in the local .aa registry')
block
  .command('add')
  .argument('<file>', 'path to a block/workflow definition (.yaml)')
  .description('validate and register a definition into the local registry')
  .action(addCommand)
block
  .command('list')
  .option('--json', 'machine-readable catalog', false)
  .description('list registered blocks & workflows')
  .action(listCommand)

program
  .command('list')
  .option('--json', 'machine-readable catalog', false)
  .description('alias of `block list`')
  .action(listCommand)

program
  .command('validate')
  .argument('<file>', 'path to a draft definition (.yaml)')
  .description('validate an agent-authored draft before registering')
  .action(validateCommand)

program
  .command('show')
  .argument('<id>', 'a registered block/workflow id')
  .option('--version <v>', 'a specific version (default: latest)')
  .description('print a registered definition (review it before approving)')
  .action(showCommand)

program
  .command('approve')
  .argument('<id>', 'a registered block/workflow id')
  .option('--version <v>', 'a specific version (default: latest)')
  .description('approve a definition for use (the user governance gate)')
  .action(approveCommand)

program
  .command('deprecate')
  .argument('<id>', 'a registered block/workflow id')
  .option('--version <v>', 'a specific version (default: latest)')
  .description('mark a definition deprecated (no longer approved)')
  .action(deprecateCommand)

const pack = program
  .command('pack')
  .description('manage workspace packs (.aa/packs — agent-authored native blocks)')
pack
  .command('register')
  .argument('<name>', 'pack name (its dir: .aa/packs/<name>)')
  .option('--path <dir>', 'pack dir relative to the workspace (default: .aa/packs/<name>)')
  .description('record a pack as draft (does not execute or load it)')
  .action(packRegisterCommand)
pack
  .command('approve')
  .argument('<name>', 'a registered pack name')
  .description('approve a pack so it loads into the runtime (it runs unsandboxed)')
  .action(packApproveCommand)
pack
  .command('list')
  .description('list registered packs and whether their content still matches approval')
  .action(packListCommand)

program
  .command('schema')
  .description('print the JSON Schema for a block/workflow definition')
  .action(schemaCommand)

program
  .command('context')
  .description('print everything a coding agent needs to author here (guide + catalog + schema)')
  .action(contextCommand)

program
  .command('report')
  .argument('<runId>', 'a run id under .aa/runs')
  .description('render a previous run report')
  .action(reportCommand)

program
  .command('mcp')
  .description('start the MCP server (stdio) so a coding agent can drive aart')
  .action(mcpCommand)

program
  .command('doctor')
  .description('check Node, sandbox, and browser setup with fix hints')
  .action(doctorCommand)

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
