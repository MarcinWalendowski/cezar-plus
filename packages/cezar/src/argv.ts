// node's `parseArgs` has no optional-value option type: a `{ type: 'string' }` option's value is
// always REQUIRED, so `--rollback` alone throws `argument missing` and `--rollback --follow` throws
// `argument is ambiguous` (node deliberately refuses to read the next flag as the value). Both are
// the shape an operator types under pressure, and the help at `:118` has advertised
// `--rollback[=<id>]` since the flag shipped. Rewrite the lone token into the explicit-empty form
// the parser does accept. Only a token that IS the flag, and is followed by nothing or by another
// dash-led token, is touched: `--rollback <id>` (space separated) already works and must keep
// working, and `--rollback=<id>` never matches.
export const OPTIONAL_VALUE_FLAGS = new Set(['--rollback']);

export function withOptionalFlagValues(argv: string[]): string[] {
  const out: string[] = [];
  let terminated = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (terminated) { out.push(token); continue; }
    if (token === '--') { terminated = true; out.push(token); continue; }
    const next = argv[i + 1];
    out.push(
      OPTIONAL_VALUE_FLAGS.has(token) && (next === undefined || next.startsWith('-'))
        ? `${token}=`
        : token,
    );
  }
  return out;
}
