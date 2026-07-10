// @aart/expr — the {{ }} expression resolver (spec §14.3, architecture §3).
export {
  EXPR_ROOTS,
  ExprSyntaxError,
  findExpressionTokens,
  parseExpression,
  type ExprRoot,
  type ParsedExpression,
  type PathSegment,
} from "./parser.js";
export {
  ExprResolutionError,
  resolveExpression,
  resolvePath,
  type ExprContext,
  type ResolveOptions,
  type SecretResolver,
} from "./resolver.js";
