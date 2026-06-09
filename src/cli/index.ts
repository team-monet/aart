#!/usr/bin/env node
import { Command } from 'commander'
import { runCommand } from './commands/run'
import { addCommand, listCommand } from './commands/block'
import { reportCommand } from './commands/report'
import { contextCommand } from './commands/context'
import { schemaCommand } from './commands/schema'
import { validateCommand } from './commands/validate'
import { mcpCommand } from './commands/mcp'

const program = new Command()

program
  .name('aart')
  .description('Agentic Automation RunTime — a governed block/workflow runtime for AI agents')
  .version('0.0.1')

program
  .command('run')
  .argument('<workflow>', 'workflow id in the registry, or a path to a .yaml file')
  .option('-i, --input <json>', 'inputs as a JSON object', '{}')
  .option('-p, --param <json>', 'params as a JSON object', '{}')
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

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
