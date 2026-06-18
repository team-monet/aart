/**
 * Pure value resolution for step inputs and control-flow conditions.
 *
 * Two reference syntaxes carried over from the legacy engine, both hardened:
 *   - `$stepId.path.to.value`  — typed reference to a prior step's output.
 *       Now supports NESTED paths (legacy was one level deep) and THROWS on a
 *       miss instead of silently returning null.
 *   - `{{ root.path }}`        — string interpolation. `root` is one of
 *       inputs|params|ctx|steps (default inputs). Also throws on a miss.
 *
 * Conditions (`step.if`) are evaluated by a small safe comparator — NOT
 * `new Function`/`eval`, which the legacy engine used (a code-injection hole).
 */

export interface ResolveScope {
  inputs: Record<string, unknown>
  params?: Record<string, unknown>
  ctx?: Record<string, unknown>
  /** Secret values, referenced as {{secrets.NAME}} (redacted from reports). */
  secrets?: Record<string, string>
  /** stepId -> that step's output object. */
  steps: Record<string, Record<string, unknown>>
  /**
   * Active forEach loop variable. Shadows any input of the same name while
   * inside a forEach iteration (lexical shadowing — expected by design).
   */
  loopVar?: { name: string; value: unknown }
  /** Zero-based index of the current forEach iteration. */
  loopIndex?: number
}

const INTERP = /\{\{\s*([\w$.]+)\s*\}\}/g

export function getPath(obj: unknown, segments: string[]): unknown {
  let cur: unknown = obj
  for (const seg of segments) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/** Resolve a single reference expression (no braces / leading $ already stripped logic). */
function resolveRef(expr: string, scope: ResolveScope): unknown {
  if (expr.startsWith('$')) {
    const [first, ...rest] = expr.slice(1).split('.')
    // forEach loop variable: $item.field (or whatever name `as` gave it).
    // Lexically shadows a step output of the same name while inside a forEach.
    if (scope.loopVar && first === scope.loopVar.name) {
      return getPath(scope.loopVar.value, rest)
    }
    // $loop.index — the zero-based iteration counter (only active inside a forEach).
    if (scope.loopVar && first === 'loop') {
      return getPath({ index: scope.loopIndex ?? 0 }, rest)
    }
    // Reserved roots — type-preserving ($root.path keeps the original type;
    // {{root.path}} stringifies — these are the typed analogs of the {{ }} switch below).
    if (first === 'inputs') return getPath(scope.inputs, rest)
    if (first === 'params') return getPath(scope.params ?? {}, rest)
    if (first === 'ctx') return getPath(scope.ctx ?? {}, rest)
    if (first === 'secrets') return getPath(scope.secrets ?? {}, rest)
    if (first === 'steps') return getPath(scope.steps, rest)
    // Fall through to the normal step-output lookup.
    const out = scope.steps[first as string]
    if (out === undefined) throw new Error(`Unknown step reference: ${expr}`)
    return getPath(out, rest)
  }
  const segs = expr.split('.')
  const root = segs[0]
  const rest = segs.slice(1)
  switch (root) {
    case 'inputs':
      return getPath(scope.inputs, rest)
    case 'params':
      return getPath(scope.params ?? {}, rest)
    case 'ctx':
      return getPath(scope.ctx ?? {}, rest)
    case 'secrets':
      return getPath(scope.secrets ?? {}, rest)
    case 'steps':
      return getPath(scope.steps, rest)
    // forEach loop variable ({{item.field}} syntax).
    // Checked before the `default` fallback so it shadows bare input names.
    default:
      if (scope.loopVar && root === scope.loopVar.name) {
        return getPath(scope.loopVar.value, rest)
      }
      if (scope.loopVar && root === 'loop') {
        return getPath({ index: scope.loopIndex ?? 0 }, rest)
      }
      // bare name -> look in inputs
      return getPath(scope.inputs, segs)
  }
}

export function resolveValue(value: unknown, scope: ResolveScope): unknown {
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, scope))
  if (value !== null && typeof value === 'object') {
    return resolveInputs(value as Record<string, unknown>, scope)
  }
  if (typeof value !== 'string') return value

  // A whole-string $ref preserves the resolved value's type.
  if (value.startsWith('$')) {
    const resolved = resolveRef(value, scope)
    if (resolved === undefined) throw new Error(`Unresolved reference: ${value}`)
    return resolved
  }

  // {{ }} interpolation always yields a string.
  if (value.includes('{{')) {
    return value.replace(INTERP, (_m, expr: string) => {
      const v = resolveRef(expr, scope)
      if (v === undefined) throw new Error(`Unresolved interpolation: {{ ${expr} }}`)
      return String(v)
    })
  }

  return value
}

/**
 * Resolve an expression to its typed value, preserving the original type.
 *
 * Used for expressions that MUST return a non-string type, such as the
 * `forEach` array expression. Supports:
 *   - `$stepId.path`   — same as resolveValue (already type-preserving)
 *   - `{{root.path}}`  — a whole-string single-template: returns the typed
 *     value rather than stringifying it (unlike normal `{{ }}` interpolation).
 *
 * This is intentionally NOT used for regular step `inputs` resolution, where
 * `{{ }}` always stringifies (that contract is preserved everywhere else).
 */
export function resolveTyped(value: string, scope: ResolveScope): unknown {
  // $ref is already type-preserving in resolveValue.
  if (value.startsWith('$')) {
    return resolveValue(value, scope)
  }
  // A whole-string single-template: return the typed value, not a string.
  const singleMatch = value.match(/^\{\{\s*([\w$.]+)\s*\}\}$/)
  if (singleMatch) {
    const v = resolveRef(singleMatch[1]!, scope)
    if (v === undefined) throw new Error(`Unresolved forEach expression: {{ ${singleMatch[1]} }}`)
    return v
  }
  // Multi-token or complex expression: fall through to resolveValue (string).
  return resolveValue(value, scope)
}

export function resolveInputs(
  record: Record<string, unknown>,
  scope: ResolveScope,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(record)) out[k] = resolveValue(v, scope)
  return out
}

// ---------------------------------------------------------------------------
// Safe condition evaluator (replaces the legacy `new Function(step.if)`).
// Grammar (MVP): `<operand> <op> <operand>` or a bare truthy `<operand>`.
// An operand is a literal (number, true/false/null, 'quoted'/"quoted") or a
// reference (inputs.x, params.x, ctx.x, $step.x, steps.id.x, or a bare name).
// Extend this grammar deliberately — never fall back to eval.
// ---------------------------------------------------------------------------

const COND = /^\s*(.+?)\s*(===|!==|==|!=|>=|<=|>|<)\s*(.+?)\s*$/

function operand(token: string, scope: ResolveScope): unknown {
  const t = token.trim()
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  if (t === 'true') return true
  if (t === 'false') return false
  if (t === 'null') return null
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1)
  }
  return resolveRef(t, scope)
}

export function evalCondition(expr: string, scope: ResolveScope): boolean {
  const m = expr.match(COND)
  if (!m) return Boolean(operand(expr, scope))
  const [, l, op, r] = m
  const a = operand(l as string, scope)
  const b = operand(r as string, scope)
  switch (op) {
    case '===':
    case '==':
      return a === b
    case '!==':
    case '!=':
      return a !== b
    case '>':
      return (a as number) > (b as number)
    case '<':
      return (a as number) < (b as number)
    case '>=':
      return (a as number) >= (b as number)
    case '<=':
      return (a as number) <= (b as number)
    default:
      return false
  }
}
