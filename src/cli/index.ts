#!/usr/bin/env node
import { Command } from 'commander'
import { runCommand } from './commands/run'
import { addCommand, listCommand } from './commands/block'
import { reportCommand } from './commands/report'
import { generateCommand } from './commands/generate'

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
  .description('register a definition into the local registry')
  .action(addCommand)
block
  .command('list')
  .description('list registered blocks & workflows')
  .action(listCommand)

program
  .command('list')
  .description('alias of `block list`')
  .action(listCommand)

program
  .command('report')
  .argument('<runId>', 'a run id under .aa/runs')
  .description('render a previous run report')
  .action(reportCommand)

program
  .command('generate')
  .argument('[prompt...]', 'natural-language description of the workflow you want')
  .description('AI-generate a workflow from natural language (Phase 4 — not yet implemented)')
  .action(generateCommand)

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
