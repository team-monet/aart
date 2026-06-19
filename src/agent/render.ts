import type { BlockDefinition } from '../core/types'

const val = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v))

/**
 * A clear, readable summary of a definition — so the user can see exactly what
 * they are approving (and so the agent can show it before asking). For a
 * workflow this lists each step and its wired inputs; for a node block, its
 * inputs/outputs and a code preview.
 */
export function renderDefinition(b: BlockDefinition): string {
  const lines: string[] = []
  lines.push(`${b.id} (${b.execution.type}) v${b.version}${b.description ? ` — ${b.description}` : ''}`)
  if (b.inputs.length) {
    const field = (i: (typeof b.inputs)[number]) => {
      const constraint = i.enum ? ` ∈ {${i.enum.join(', ')}}` : i.pattern ? ` ~ /${i.pattern}/` : ''
      const dflt = i.default !== undefined ? ` = ${JSON.stringify(i.default)}` : ''
      return `${i.name}${i.required ? '*' : ''}:${i.type}${constraint}${dflt}`
    }
    lines.push(`  inputs: ${b.inputs.map(field).join(', ')}`)
  }

  if (b.execution.type === 'workflow') {
    lines.push('  steps:')
    b.execution.steps.forEach((s, i) => {
      const ins = Object.entries(s.inputs ?? {})
        .map(([k, v]) => `${k}=${val(v)}`)
        .join(', ')
      const branch = s.if ? `   if(${s.if}) → ${s.then ?? '∅'} else ${s.else ?? '∅'}` : ''
      const loop = s.forEach ? `   forEach ${s.forEach} as ${s.as ?? 'item'}` : ''
      lines.push(`    ${i + 1}. ${s.id} → ${s.block}${ins ? `   ${ins}` : ''}${loop}${branch}`)
    })
    if (b.execution.outputMapping) {
      lines.push(
        `  outputs: ${Object.entries(b.execution.outputMapping)
          .map(([k, v]) => `${k} ← ${v}`)
          .join(', ')}`,
      )
    }
  } else if (b.execution.type === 'command') {
    if (b.outputs.length) lines.push(`  outputs: ${b.outputs.map((o) => `${o.name}:${o.type}`).join(', ')}`)
    lines.push(`  command: $ ${[b.execution.command, ...b.execution.args].join(' ')}`)
    if (b.execution.cwd) lines.push(`  cwd: ${b.execution.cwd}`)
    if (b.execution.env && Object.keys(b.execution.env).length) {
      lines.push(`  env: ${Object.entries(b.execution.env).map(([k, v]) => `${k}=${v}`).join(', ')}`)
    }
    if (b.execution.failOnError === false) lines.push('  failOnError: false (workflow branches on exitCode)')
    lines.push(
      '  ⚠ HOST COMMAND — approving runs exactly this command shape on this machine, ' +
        'with inputs filling the {{slots}} shown above. Every run is recorded.',
    )
  } else if (b.execution.type === 'node') {
    if (b.outputs.length) lines.push(`  outputs: ${b.outputs.map((o) => `${o.name}:${o.type}`).join(', ')}`)
    if (b.execution.dependencies?.length) {
      lines.push(`  dependencies: ${b.execution.dependencies.join(', ')}`)
      lines.push(
        '  ⚠ UNSANDBOXED — approving this runs it as a real Node.js process with the npm ' +
          'packages above and full access to this machine.',
      )
    }
    const code = b.execution.code.trim()
    lines.push('  code:')
    for (const line of (code.length > 400 ? code.slice(0, 400) + '\n…' : code).split('\n')) {
      lines.push(`    ${line}`)
    }
  }
  return lines.join('\n')
}
