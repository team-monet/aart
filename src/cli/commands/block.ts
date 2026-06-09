import fs from 'node:fs'
import YAML from 'yaml'
import { BlockDefinitionSchema } from '../../core/types'
import { openRegistry } from '../workspace'

export async function addCommand(file: string): Promise<void> {
  if (!fs.existsSync(file)) {
    console.error(`File not found: ${file}`)
    process.exit(1)
  }
  const def = BlockDefinitionSchema.parse(YAML.parse(fs.readFileSync(file, 'utf8')))
  openRegistry().registerBlock(def)
  const kind = def.execution.type === 'workflow' ? 'workflow' : 'block'
  console.log(`registered ${kind} ${def.id}@${def.version} (${def.name})`)
}

export async function listCommand(): Promise<void> {
  const blocks = openRegistry().listBlocks()
  if (!blocks.length) {
    console.log('no blocks registered yet — try:  aart block add <file>')
    return
  }
  for (const b of blocks) {
    console.log(`${b.id}@${b.version}\t[${b.execution.type}]\t${b.name}`)
  }
}
