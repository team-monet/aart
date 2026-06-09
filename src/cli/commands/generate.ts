/**
 * Placeholder for the AI workflow generator (Phase 4). The flow it will drive:
 *   1. take a natural-language request (+ optional --app-url etc.)
 *   2. list available blocks from the registry
 *   3. draft a workflow YAML that composes them (zod-validated, repair loop)
 *   4. preview it and require explicit approval (the human-in-the-loop gate)
 *   5. register + run, then print the report
 * See docs/IMPLEMENTATION_PLAN.md → Phase 4.
 */
export async function generateCommand(prompt: string[]): Promise<void> {
  const ask = prompt.join(' ').trim()
  console.error('`aart generate` (AI workflow generation) is not implemented yet — Phase 4.')
  if (ask) console.error(`\nyou asked: "${ask}"`)
  console.error(
    '\nWhen built, it will draft a workflow from this request, preview it for your\n' +
      'approval, run it deterministically, and leave a structured evidence report.',
  )
  process.exit(1)
}
