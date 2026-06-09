import { definitionJsonSchema } from '../../agent/schema'

/** `aart schema` — emit the JSON Schema for a block/workflow definition. */
export async function schemaCommand(): Promise<void> {
  console.log(JSON.stringify(definitionJsonSchema(), null, 2))
}
