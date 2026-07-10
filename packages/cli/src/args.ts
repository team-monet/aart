// A small, dependency-free argv tokenizer. The CLI surface (spec §33) is
// fixed and simple enough (`aart <command> [subcommand] <positional...>
// [--flag value | --flag=value | --boolean-flag]`) that pulling in
// commander/yargs would add a dependency for something ~30 lines covers,
// and keeps @team-monet/aart's own dependency footprint (the one package
// that actually ships to npm, ADR-18) minimal.
export interface Tokenized {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export function tokenize(argv: readonly string[]): Tokenized {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      if (eq !== -1) {
        flags[tok.slice(2, eq)] = tok.slice(eq + 1);
        continue;
      }
      const name = tok.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      positionals.push(tok);
    }
  }
  return { positionals, flags };
}

export function flagString(flags: Tokenized["flags"], name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

export function flagBoolean(flags: Tokenized["flags"], name: string): boolean {
  return flags[name] === true || flags[name] === "true";
}

export function requireFlagString(flags: Tokenized["flags"], name: string): string {
  const v = flagString(flags, name);
  if (v === undefined) throw new Error(`Missing required --${name} flag.`);
  return v;
}

export function requirePositional(positionals: readonly string[], index: number, label: string): string {
  const v = positionals[index];
  if (v === undefined) throw new Error(`Missing required argument: ${label}.`);
  return v;
}
