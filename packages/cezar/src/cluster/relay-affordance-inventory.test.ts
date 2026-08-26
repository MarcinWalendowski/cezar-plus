import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createScanner, SyntaxKind as K } from 'typescript/unstable/ast';
import { stripLocalAffordances } from './relay.ts';

/**
 * Guards the denylist `LOCAL_AFFORDANCE_KEYS` in `relay.ts` against the failure mode its own
 * docblock names: *"a denylist on a security boundary fails open... adding an event field that
 * carries a local affordance is a security change, not a feature. It gets reviewed as one."*
 * That sentence is a process rule, not a test — this file is the test the rule needs.
 *
 * A hand-typed list of "the fields I noticed" would itself be exactly the kind of thing that
 * silently goes stale, so this file re-derives the inventory from source on every run: it walks
 * every real `.appendEvent(` / `.emitEphemeral(` call site under `packages/cezar/src` (plus the
 * `emit(...)` calls that thread through them — see `RUN_EVENT_SHAPED_EMIT_RE` below) for their
 * literal object keys, and resolves the handful of named types spread into those calls
 * (`AgentEvent`, `UiEvent` today — see `KNOWN_SPREAD_TYPES`'s correction note for a third,
 * `PersistedAttachment`, that this file used to resolve until the leak it carried was fixed at
 * its producer) by parsing their declarations wherever the source's own `import` statements
 * point. None of this is a TypeScript type-checker — `typescript`
 * is pinned to v7 in this repo, whose npm package no longer ships the classic compiler API
 * (`ts.createProgram` et al. do not exist at runtime here — verified). What IS available is the
 * real tokenizer (`typescript/unstable/ast`'s `createScanner`), which is what this file is built
 * on: syntactic, not semantic, so it resolves "what fields does this type declare" but not "what
 * is the true type of this specific expression" when that requires contextual/inferred typing
 * (see the `KNOWN_SPREAD_TYPES` docblock for where that boundary actually bites).
 *
 * Every inventoried field is required to be explicitly classified below (`FIELD_CLASSIFICATION`)
 * — an unclassified field fails the test by name, which is the forcing function: a new event
 * field is invisible to `git diff` review unless something makes it fail loudly, and this is
 * that something. A field classified `risky` must appear in `LOCAL_AFFORDANCE_KEYS` or the test
 * fails naming it and why it matters.
 */

// ============================================================================================
// Tokenizer — a thin, purpose-built layer over the real TS scanner (see docblock above for why
// there is no full parser/checker available). Two correctness traps found and fixed while
// building this: (1) `` `${a}${b ? `${c}` : ''}` `` needs explicit template-interpolation
// resumption via `reScanTemplateToken`, or the naive brace count desyncs; (2) a bare `.scan()`
// treats every `/` as division, so a real regex literal elsewhere in the file (found in
// `src/backup/providers/s3.ts`: `/&#(\d+);/g`) sends the scanner into a token it can never
// finish, spinning until the process OOMs — `reScanSlashToken()` is required whenever the
// previous token could not have ended an expression.
// ============================================================================================

interface Token {
  kind: number;
  text: string;
  start: number;
  end: number;
}

const EXPR_END_KINDS = new Set<number>([
  K.Identifier, K.PrivateIdentifier, K.NumericLiteral, K.BigIntLiteral, K.StringLiteral,
  K.NoSubstitutionTemplateLiteral, K.TemplateTail, K.RegularExpressionLiteral,
  K.CloseParenToken, K.CloseBracketToken,
  K.ThisKeyword, K.TrueKeyword, K.FalseKeyword, K.NullKeyword, K.SuperKeyword,
  K.PlusPlusToken, K.MinusMinusToken,
]);

function tokenize(text: string): Token[] {
  const scanner = createScanner(true, 0, text);
  const tokens: Token[] = [];
  const templateDepthStack: number[] = [];
  let depth = 0;
  let prevKind: number | undefined;
  let tok = scanner.scan();
  let guard = 0;
  const maxTokens = text.length + 1000; // a well-formed file can never emit more tokens than this
  while (tok !== K.EndOfFile) {
    if (++guard > maxTokens) {
      throw new Error(`tokenize: runaway scan past ${maxTokens} tokens for ${text.length}-char input`);
    }
    if ((tok === K.SlashToken || tok === K.SlashEqualsToken) && !(prevKind !== undefined && EXPR_END_KINDS.has(prevKind))) {
      tok = scanner.reScanSlashToken();
    }
    if (tok === K.OpenBraceToken) depth++;
    if (tok === K.CloseBraceToken) {
      if (templateDepthStack.length > 0 && templateDepthStack[templateDepthStack.length - 1] === depth) {
        templateDepthStack.pop();
        const resumed = scanner.reScanTemplateToken(false);
        tokens.push({ kind: resumed, text: scanner.getTokenText(), start: scanner.getTokenStart(), end: scanner.getTokenEnd() });
        prevKind = resumed;
        if (resumed === K.TemplateMiddle) templateDepthStack.push(depth);
        tok = scanner.scan();
        continue;
      }
      depth--;
    }
    if (tok === K.TemplateHead) templateDepthStack.push(depth);
    tokens.push({ kind: tok, text: scanner.getTokenText(), start: scanner.getTokenStart(), end: scanner.getTokenEnd() });
    prevKind = tok;
    tok = scanner.scan();
  }
  return tokens;
}

// Depth counters used to find "the end of this span" without a real parser. Two variants:
// runtime VALUE spans never treat `<`/`>` as brackets (they are almost always comparisons in an
// expression, and treating every `>` as a closer desyncs the whole rest of the file — this is
// exactly the bug class #2 above, just for `<`/`>` instead of `/`); TYPE spans (interface/type
// alias members) safely include `<`/`>` because a type position never contains a comparison.
const VALUE_OPENERS = new Set<number>([K.OpenParenToken, K.OpenBracketToken, K.OpenBraceToken]);
const VALUE_CLOSERS = new Set<number>([K.CloseParenToken, K.CloseBracketToken, K.CloseBraceToken]);
const TYPE_OPENERS = new Set<number>([K.OpenParenToken, K.OpenBracketToken, K.OpenBraceToken, K.LessThanToken]);
const TYPE_CLOSERS = new Set<number>([K.CloseParenToken, K.CloseBracketToken, K.CloseBraceToken, K.GreaterThanToken]);

function skipToTopLevel(
  tokens: Token[],
  idx: number,
  stopKinds: Set<number>,
  openers: Set<number> = VALUE_OPENERS,
  closers: Set<number> = VALUE_CLOSERS,
): number {
  let d = 0;
  while (idx < tokens.length) {
    const k = tokens[idx]!.kind;
    if (d === 0 && stopKinds.has(k)) return idx;
    if (openers.has(k)) d++;
    else if (closers.has(k)) d--;
    idx++;
  }
  return idx;
}

function splitTopLevel(tokens: Token[], start: number, end: number, sepKind: number): Token[][] {
  const parts: Token[][] = [];
  let d = 0;
  let segStart = start;
  for (let i = start; i < end; i++) {
    const k = tokens[i]!.kind;
    if (d === 0 && k === sepKind) {
      parts.push(tokens.slice(segStart, i));
      segStart = i + 1;
    } else if (TYPE_OPENERS.has(k)) d++;
    else if (TYPE_CLOSERS.has(k)) d--;
  }
  parts.push(tokens.slice(segStart, end));
  return parts.filter((p) => p.length > 0);
}

// ============================================================================================
// Call-site key extraction — the primary, fully-mechanical source of the inventory.
// ============================================================================================

interface ObjProp {
  kind: 'prop' | 'spread' | 'computed';
  name?: string;
  nested?: ObjProp[];
  exprTokens?: Token[];
  exprText?: string;
}

/** Parses an object literal's own properties (recursing into nested object-literal VALUES, to
 *  match `stripDeep`'s whole-tree walk in relay.ts). `tokens[openIdx]` must be `{`. */
function parseObjectLiteral(tokens: Token[], openIdx: number): { props: ObjProp[]; closeIdx: number } {
  const props: ObjProp[] = [];
  let i = openIdx + 1;
  const stop = new Set<number>([K.CommaToken, K.CloseBraceToken]);
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t.kind === K.CloseBraceToken) break; // trailing comma before `}` — object ends here
    if (t.kind === K.DotDotDotToken) {
      const exprStart = i + 1;
      const exprEnd = skipToTopLevel(tokens, exprStart, stop);
      const exprTokens = tokens.slice(exprStart, exprEnd);
      props.push({ kind: 'spread', exprTokens, exprText: exprTokens.map((x) => x.text).join(' ') });
      i = exprEnd;
    } else if (t.kind === K.OpenBracketToken) {
      const closeIdx = skipToTopLevel(tokens, i + 1, new Set([K.CloseBracketToken]));
      i = closeIdx + 1;
      if (tokens[i]?.kind === K.ColonToken) {
        i = skipToTopLevel(tokens, i + 1, stop);
        props.push({ kind: 'computed' });
      }
    } else if (t.kind === K.Identifier || t.kind === K.StringLiteral || t.kind >= 80) {
      // `t.kind >= 80` admits reserved words used as property names (e.g. `type`, `default`),
      // matching this codebase's real event shapes (`type: 'note'`).
      const name = t.kind === K.StringLiteral ? t.text.slice(1, -1) : t.text;
      const next = tokens[i + 1];
      if (next?.kind === K.ColonToken) {
        const valueStart = i + 2;
        let nested: ObjProp[] = [];
        if (tokens[valueStart]?.kind === K.OpenBraceToken) {
          const parsed = parseObjectLiteral(tokens, valueStart);
          nested = parsed.props;
          i = skipToTopLevel(tokens, parsed.closeIdx + 1, stop);
        } else {
          i = skipToTopLevel(tokens, valueStart, stop);
        }
        props.push({ kind: 'prop', name, nested });
      } else {
        props.push({ kind: 'prop', name, nested: [] });
        i = skipToTopLevel(tokens, i + 1, stop);
      }
    } else {
      i++;
      continue;
    }
    if (tokens[i]?.kind === K.CommaToken) { i++; continue; }
    break;
  }
  return { props, closeIdx: i };
}

interface CallSite {
  args: Token[][];
}

function findCalls(tokens: Token[], names: Set<string>, dotPrefixed: boolean): CallSite[] {
  const out: CallSite[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind !== K.Identifier || !names.has(t.text)) continue;
    if (tokens[i + 1]?.kind !== K.OpenParenToken) continue;
    const isDotPrefixed = tokens[i - 1]?.kind === K.DotToken;
    if (dotPrefixed !== isDotPrefixed) continue;
    const openIdx = i + 1;
    const closeIdx = skipToTopLevel(tokens, openIdx + 1, new Set([K.CloseParenToken]));
    const args: Token[][] = [];
    let start = openIdx + 1;
    let d = 0;
    for (let j = openIdx + 1; j < closeIdx; j++) {
      const k = tokens[j]!.kind;
      if (VALUE_OPENERS.has(k)) d++;
      else if (VALUE_CLOSERS.has(k)) d--;
      else if (k === K.CommaToken && d === 0) {
        args.push(tokens.slice(start, j));
        start = j + 1;
      }
    }
    if (start < closeIdx) args.push(tokens.slice(start, closeIdx));
    out.push({ args });
  }
  return out;
}

function walkTsFiles(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walkTsFiles(p, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.testkit.ts')) out.push(p);
  }
  return out;
}

/** A bare `emit(...)` call is only in-scope when the enclosing FILE's own `emit` is declared
 *  with the RunEvent-shaped parameter `{ type: string; stepId?: string; ... }` — run.ts's
 *  threading pattern (`const emit = (event) => this.store.appendEvent(runId, {...event, stepId})`,
 *  reused as a callback parameter ~10 times). Other files reuse the bare name `emit` for
 *  unrelated local callbacks that must NOT be folded into this inventory — found two real ones
 *  while building this: `index.ts`'s CLI dual JSON/text output helper (`emit(value, lines)`) and
 *  `server/checkout.ts`'s clone-progress narration (`CheckoutProgressEvent`, no `stepId`, no
 *  confirmed path to the run-event stream at all). Both would have polluted the inventory with
 *  fields (`hubNodeId`, `phase`, `checkoutId`, ...) that never reach a `RunEvent`. */
const RUN_EVENT_SHAPED_EMIT_RE = /\bemit\s*[:=]\s*\([\s\S]{0,200}?\bstepId\b/;

export interface InventoryResult {
  totalCallSites: number;
  /** field name -> set of "`file:line`" provenance strings where it appeared as a literal key */
  literalKeys: Map<string, Set<string>>;
  /** raw spread-expression text -> set of provenance strings */
  spreads: Map<string, Set<string>>;
}

/** Scans every `.appendEvent(`/`.emitEphemeral(` call (and, per-file, every RunEvent-shaped bare
 *  `emit(...)` call) under `srcRoot` for the literal object keys and spread expressions passed as
 *  the event argument. This is the whole floor: if it ever finds zero call sites, every assertion
 *  built on top of it is vacuous — see the "floor assertion is not vacuous" test below, which
 *  proves that by pointing this exact function at an empty directory. */
function scanAppendEventCallSites(srcRoot: string): InventoryResult {
  const files = walkTsFiles(srcRoot, []);
  const literalKeys = new Map<string, Set<string>>();
  const spreads = new Map<string, Set<string>>();
  let totalCallSites = 0;

  function addKey(key: string, provenance: string) {
    if (!literalKeys.has(key)) literalKeys.set(key, new Set());
    literalKeys.get(key)!.add(provenance);
  }
  function addSpread(expr: string, provenance: string) {
    if (!spreads.has(expr)) spreads.set(expr, new Set());
    spreads.get(expr)!.add(provenance);
  }
  function collect(props: ObjProp[], provenance: string) {
    for (const p of props) {
      if (p.kind === 'prop' && p.name !== undefined) {
        addKey(p.name, provenance);
        if (p.nested && p.nested.length > 0) collect(p.nested, `${provenance} > nested:${p.name}`);
      } else if (p.kind === 'spread' && p.exprTokens !== undefined) {
        const condKeys = tryExtractConditionalObjectLiteralKeys(p.exprTokens);
        if (condKeys) {
          collect(condKeys, `${provenance} > conditional-spread:(${p.exprText})`);
        } else if (p.exprText !== undefined) {
          addSpread(p.exprText, provenance);
        }
      }
    }
  }
  function processArg(text: string, file: string, arg: Token[] | undefined, suffix: string) {
    totalCallSites++;
    if (!arg || arg.length === 0) return;
    const rel = file.replace(srcRoot + '/', 'src/');
    const lineNo = text.slice(0, arg[0]!.start).split('\n').length;
    const provenance = `${rel}:${lineNo}${suffix}`;
    if (arg[0]!.kind === K.OpenBraceToken) {
      const { props } = parseObjectLiteral(arg, 0);
      collect(props, provenance);
    } else if (arg.length === 1 && arg[0]!.kind === K.Identifier) {
      addSpread(arg[0]!.text, `${provenance} (bare identifier arg)`);
    } else {
      throw new Error(
        `scanAppendEventCallSites: unrecognized event-argument shape at ${provenance}: ` +
          `${arg.map((t) => t.text).join(' ')} — this scanner needs a new case, not a silent skip.`,
      );
    }
  }

/** Strips one layer of matching, whole-span parens, e.g. `(a ? b : c)` -> `a ? b : c`. Leaves
 *  the tokens untouched if the first/last tokens are not a genuinely matching outer pair (a
 *  coincidental leading/trailing paren that belongs to something nested would not span to the
 *  true end, which `skipToTopLevel` catches). */
function stripSurroundingParens(tokens: Token[]): Token[] {
  if (tokens.length < 2 || tokens[0]!.kind !== K.OpenParenToken || tokens[tokens.length - 1]!.kind !== K.CloseParenToken) {
    return tokens;
  }
  const closeIdx = skipToTopLevel(tokens, 1, new Set([K.CloseParenToken]));
  if (closeIdx !== tokens.length - 1) return tokens;
  return tokens.slice(1, -1);
}

/** Handles this codebase's real conditional-spread idiom — `...(cond ? { stepId } : {})`,
 *  `...(attachments.length ? { images: ... } : {})` — by extracting the keys from whichever
 *  branch(es) are themselves object literals, rather than reporting the whole ternary as an
 *  opaque, unaccounted-for spread (which is what an EARLIER version of this scanner did: it
 *  assumed `parseObjectLiteral`'s nested-value recursion already covered this case, which is
 *  wrong — a ternary's branches are not a nested object-literal VALUE, they are a spread
 *  EXPRESSION, a different code path. Caught by the "every spread is accounted for" test
 *  itself going red against five real call sites the first time this file was run — exactly
 *  the forcing function this file exists to be, just aimed at its own bug instead of relay.ts).
 *  Returns null (meaning: not this shape, report it as a spread) for anything else, e.g. a
 *  ternary with a non-object-literal branch. */
function tryExtractConditionalObjectLiteralKeys(tokens: Token[]): ObjProp[] | null {
  const inner = stripSurroundingParens(tokens);
  const qIdx = skipToTopLevel(inner, 0, new Set([K.QuestionToken]));
  if (qIdx >= inner.length) return null;
  const colonIdx = skipToTopLevel(inner, qIdx + 1, new Set([K.ColonToken]));
  if (colonIdx >= inner.length) return null;
  const branches = [inner.slice(qIdx + 1, colonIdx), inner.slice(colonIdx + 1)];
  const branchKeys: ObjProp[] = [];
  for (const branch of branches) {
    if (branch.length === 0) continue;
    if (branch[0]!.kind !== K.OpenBraceToken) return null;
    const { props, closeIdx } = parseObjectLiteral(branch, 0);
    if (closeIdx !== branch.length - 1) return null;
    branchKeys.push(...props);
  }
  return branchKeys;
}

  const DOT_NAMES = new Set(['appendEvent', 'emitEphemeral']);
  const BARE_NAMES = new Set(['emit']);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const tokens = tokenize(text);
    for (const call of findCalls(tokens, DOT_NAMES, true)) {
      processArg(text, file, call.args[1], '');
    }
    if (RUN_EVENT_SHAPED_EMIT_RE.test(text)) {
      for (const call of findCalls(tokens, BARE_NAMES, false)) {
        processArg(text, file, call.args[0], ' (via emit(...))');
      }
    }
  }
  return { totalCallSites, literalKeys, spreads };
}

// ============================================================================================
// Named-type resolution — for the handful of spreads that aren't inline object literals
// (`{ ...saved }`, `{ ...event, stepId }`). Resolves `export interface NAME {...}` and
// `export type NAME = ...` declarations by following the source's own relative `import`
// statements, so a type moving files or gaining a member is picked up automatically; only the
// STARTING "which type does this spread variable have" fact is asserted by hand (see
// `KNOWN_SPREAD_TYPES` below) — resolving that generically would need real contextual typing
// (see its docblock).
// ============================================================================================

interface TypeMember { name: string; optional: boolean; typeTokens: Token[] }
type TypeDecl = { kind: 'interface'; members: TypeMember[] } | { kind: 'alias'; arms: Token[][] };

function parseTypeLiteralMembers(tokens: Token[], openIdx: number): { members: TypeMember[]; closeIdx: number } {
  const members: TypeMember[] = [];
  let i = openIdx + 1;
  const stop = new Set<number>([K.SemicolonToken, K.CommaToken, K.CloseBraceToken]);
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t.kind === K.CloseBraceToken) break;
    if (t.kind === K.SemicolonToken || t.kind === K.CommaToken) { i++; continue; }
    if (t.kind !== K.Identifier && t.kind !== K.StringLiteral) {
      i = skipToTopLevel(tokens, i, stop, TYPE_OPENERS, TYPE_CLOSERS);
      continue;
    }
    const name = t.kind === K.StringLiteral ? t.text.slice(1, -1) : t.text;
    let j = i + 1;
    let optional = false;
    if (tokens[j]?.kind === K.QuestionToken) { optional = true; j++; }
    if (tokens[j]?.kind !== K.ColonToken) {
      i = skipToTopLevel(tokens, i, stop, TYPE_OPENERS, TYPE_CLOSERS);
      continue;
    }
    const typeStart = j + 1;
    const typeEnd = skipToTopLevel(tokens, typeStart, stop, TYPE_OPENERS, TYPE_CLOSERS);
    members.push({ name, optional, typeTokens: tokens.slice(typeStart, typeEnd) });
    i = typeEnd;
  }
  return { members, closeIdx: i };
}

function parseTypeDeclarations(tokens: Token[]): Map<string, TypeDecl> {
  const decls = new Map<string, TypeDecl>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === K.InterfaceKeyword && tokens[i + 1]?.kind === K.Identifier) {
      const name = tokens[i + 1]!.text;
      const j = skipToTopLevel(tokens, i + 2, new Set([K.OpenBraceToken]));
      if (tokens[j]?.kind !== K.OpenBraceToken) continue;
      const { members, closeIdx } = parseTypeLiteralMembers(tokens, j);
      decls.set(name, { kind: 'interface', members });
      i = closeIdx;
    } else if (t.kind === K.TypeKeyword && tokens[i + 1]?.kind === K.Identifier) {
      const name = tokens[i + 1]!.text;
      const j = i + 2;
      if (tokens[j]?.kind !== K.EqualsToken) continue;
      const rhsStart = j + 1;
      const rhsEnd = skipToTopLevel(tokens, rhsStart, new Set([K.SemicolonToken]), TYPE_OPENERS, TYPE_CLOSERS);
      decls.set(name, { kind: 'alias', arms: splitTopLevel(tokens, rhsStart, rhsEnd, K.BarToken) });
      i = rhsEnd;
    }
  }
  return decls;
}

interface ImportedName { exported: string; modulePath: string }

function parseImports(tokens: Token[]): Map<string, ImportedName> {
  const map = new Map<string, ImportedName>();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.kind !== K.ImportKeyword) continue;
    let j = i + 1;
    if (tokens[j]?.kind === K.TypeKeyword) j++;
    if (tokens[j]?.kind !== K.OpenBraceToken) continue; // default/namespace imports carry no type names we need
    const closeIdx = skipToTopLevel(tokens, j + 1, new Set([K.CloseBraceToken]));
    const specTokens = tokens.slice(j + 1, closeIdx);
    let k = closeIdx + 1;
    if (tokens[k]?.kind === K.FromKeyword) k++;
    if (tokens[k]?.kind !== K.StringLiteral) continue;
    const modulePath = tokens[k]!.text.slice(1, -1);
    for (const part of splitTopLevel(specTokens, 0, specTokens.length, K.CommaToken)) {
      const clean = part.filter((tk) => tk.kind !== K.TypeKeyword);
      if (clean.length === 0) continue;
      const localName = clean[clean.length - 1]!.text; // handles `X as Y` and plain `X`
      map.set(localName, { exported: clean[0]!.text, modulePath });
    }
  }
  return map;
}

interface LoadedFile { decls: Map<string, TypeDecl>; imports: Map<string, ImportedName> }
const fileCache = new Map<string, LoadedFile>();

function loadFile(absPath: string): LoadedFile {
  const cached = fileCache.get(absPath);
  if (cached) return cached;
  const text = readFileSync(absPath, 'utf8');
  const tokens = tokenize(text);
  const entry: LoadedFile = { decls: parseTypeDeclarations(tokens), imports: parseImports(tokens) };
  fileCache.set(absPath, entry);
  return entry;
}

function findDeclFile(fromFile: string, typeName: string, depth = 0): string | null {
  if (depth > 6) return null; // generous bound for this codebase's import depth; guards a cycle
  const entry = loadFile(fromFile);
  if (entry.decls.has(typeName)) return fromFile;
  const imp = entry.imports.get(typeName);
  if (imp && imp.modulePath.startsWith('.')) {
    const target = resolve(dirname(fromFile), imp.modulePath);
    return findDeclFile(target, imp.exported, depth + 1);
  }
  return null;
}

function baseTypeRefName(typeTokens: Token[]): string | null {
  let toks = typeTokens;
  while (toks.length >= 2 && toks[toks.length - 1]!.kind === K.CloseBracketToken && toks[toks.length - 2]!.kind === K.OpenBracketToken) {
    toks = toks.slice(0, -2); // strip a trailing `[]`
  }
  return toks.length === 1 && toks[0]!.kind === K.Identifier ? toks[0]!.text : null;
}

export interface FlattenedField { field: string | null; ownerType: string; optional: boolean; unresolved?: string }

/** Flattens a type name to every field it (transitively) carries, tagging each with the type
 *  path it came from (`ownerType`) — the provenance this file needs to tell `PersistedAttachment
 *  .path` (a real local filesystem path) apart from `FileDiff.path`/`ToolLocation.path` (repo-
 *  relative, not local-machine-specific), which share a bare key name but not a risk profile.
 *  An unresolvable reference produces `{ field: null, unresolved: name }` rather than silently
 *  vanishing — a resolver that failed open here would be exactly the bug this file exists to
 *  catch one layer up. */
function flattenType(fromFile: string, typeName: string, seen: Set<string> = new Set(), ownerLabel = typeName): FlattenedField[] {
  const key = `${fromFile}#${typeName}`;
  if (seen.has(key)) return [];
  seen.add(key);
  const declFile = findDeclFile(fromFile, typeName);
  if (!declFile) return [{ field: null, ownerType: ownerLabel, optional: false, unresolved: typeName }];
  const decl = loadFile(declFile).decls.get(typeName);
  if (!decl) return [{ field: null, ownerType: ownerLabel, optional: false, unresolved: typeName }];
  const out: FlattenedField[] = [];
  if (decl.kind === 'interface') {
    for (const m of decl.members) {
      out.push({ field: m.name, ownerType: ownerLabel, optional: m.optional });
      const ref = baseTypeRefName(m.typeTokens);
      if (ref) out.push(...flattenType(declFile, ref, seen, `${ownerLabel}.${m.name}:${ref}`));
    }
  } else {
    for (const arm of decl.arms) {
      if (arm[0]?.kind === K.OpenBraceToken) {
        const { members } = parseTypeLiteralMembers(arm, 0);
        const disc = members.find((m) => m.name === 'type' && m.typeTokens.length === 1 && m.typeTokens[0]!.kind === K.StringLiteral);
        const armLabel = disc ? `${ownerLabel}[${disc.typeTokens[0]!.text}]` : ownerLabel;
        for (const m of members) {
          out.push({ field: m.name, ownerType: armLabel, optional: m.optional });
          const ref = baseTypeRefName(m.typeTokens);
          if (ref) out.push(...flattenType(declFile, ref, seen, `${armLabel}.${m.name}:${ref}`));
        }
      } else {
        const ref = baseTypeRefName(arm);
        if (ref) out.push(...flattenType(declFile, ref, seen, `${ownerLabel}|${ref}`));
      }
    }
  }
  return out;
}

// ============================================================================================
// The reviewed inventory. Every field this file's scan finds — as a literal call-site key, or
// nested inside one of the two named types actually spread into an event — must be listed here.
// An unlisted field fails the test by name: that IS the security review the docblock asks for,
// made mandatory instead of optional.
// ============================================================================================

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUN_TS = resolve(SRC_ROOT, 'workflows/run.ts');
const UI_EVENT_SINK_TS = resolve(SRC_ROOT, 'runs/ui-event-sink.ts');

/**
 * `event` is the only bare-identifier spread this codebase's `appendEvent` / `emitEphemeral` /
 * RunEvent-shaped `emit(...)` call sites use (verified by `scanAppendEventCallSites` — see the
 * "every spread is accounted for" test). What it resolves to is asserted here BY HAND, and that
 * is a real, stated limitation, not an oversight: the general case needs contextual typing this
 * repo's `typescript` v7 cannot provide (see the file docblock). Concretely, `run.ts:5582`'s
 * `persist: (event) => this.store.appendEvent(runId, {...event, stepId})` has NO syntactic type
 * annotation on `event` — it is contextually typed as `WireEvent` (`{ type: string; [key: string]:
 * unknown }`, an index signature) by `UiEventSinkOutput.persist`, which tells a syntactic scanner
 * nothing. The REAL values that reach it are `UiEvent`s, forwarded verbatim by
 * `UiEventSink.persist()`/`.emitLive()` (`runs/ui-event-sink.ts:200-210`:
 * `this.out.persist(event as WireEvent)`) — confirmed by reading that file, not inferred. So
 * `event` is resolved against BOTH type graphs it can actually carry: v1's `AgentEvent` (the
 * `onEvent = (event: AgentEvent) => ...` closures in `run.ts`, which DO carry an explicit
 * annotation) and v2's `UiEvent` (via `ui-event-sink.ts`).
 *
 * **CORRECTED 2026-08-23**: this list used to also carry `{ file: RUN_TS, type:
 * 'PersistedAttachment' }` for a `saved` spread — `run.ts:3671`/`:5184`'s two `type: 'image'`
 * event sites used to write `{ ...saved }`, which is exactly how `PersistedAttachment.path` (an
 * absolute local filesystem path) reached a relayed event undetected by a key denylist. Fixed at
 * the producer: both sites now project `{ name: saved.name, url: saved.url }` explicitly instead
 * of spreading, so `saved`/`PersistedAttachment` is no longer a real spread anywhere in this
 * codebase — removed from here to match (an entry for a type nothing spreads would be exactly
 * the hand-typed, stale-snapshot problem this file exists to avoid). `'saved'` was also dropped
 * from `knownIdentifiers` below, so if this pattern ever comes back, it fails as an unrecognized
 * spread rather than being silently re-admitted by a leftover allowlist entry.
 *
 * The residual this leaves: if a FUTURE call site spreads a differently-typed variable that also
 * happens to be named `event`, this file will not detect a genuinely new field on that new type —
 * it only re-checks the two type graphs listed here, not "what does `event` mean at this specific
 * new line." A full fix needs a real type checker (`ts-morph`/`tsserver`), which is not available
 * in this repo's toolchain. Flagged in the delivery report; not silently papered over.
 */
const KNOWN_SPREAD_TYPES: ReadonlyArray<{ file: string; type: string }> = [
  { file: RUN_TS, type: 'AgentEvent' }, // `event` — run.ts's v1 `onEvent = (event: AgentEvent) => ...` closures
  { file: UI_EVENT_SINK_TS, type: 'UiEvent' }, // `event` — v2 path, see docblock above
];

type Verdict =
  | { verdict: 'safe'; why: string }
  | { verdict: 'risky'; why: string }
  /** `path` is the one field this codebase gives two different meanings under the same bare key
   *  name: an absolute LOCAL filesystem path on `PersistedAttachment` (risky), and a repo-
   *  relative, portable path on `FileDiff`/`ToolLocation` (safe, and needed for "jump to file").
   *  Classified by which owner-type path (`ownerType`, from `flattenType`'s provenance tagging)
   *  the occurrence came from, rather than by bare name.
   *
   *  `coverage` names WHICH of `stripLocalAffordances`'s two independent mechanisms is
   *  responsible for closing this occurrence, and therefore which one this test must probe:
   *  `'denylist'` — the field name itself must be in `LOCAL_AFFORDANCE_KEYS` (checked via
   *  `LOCAL_AFFORDANCE_KEYS.has`, below); `'path-regex'` — the field's real VALUE is always an
   *  absolute filesystem path, so it is redacted by `LOCAL_PATH_RE` regardless of key, and a key
   *  denylist entry would be the wrong fix (see `PersistedAttachment.path` below for why:
   *  `FileDiff.path`/`ToolLocation.path` share the bare name and are legitimately repo-relative).
   *  Checked by asserting `stripLocalAffordances` actually redacts a realistic value for this
   *  field under every root `LOCAL_PATH_RE` currently recognizes — proving the CURRENT regex
   *  covers it, not merely that the regex exists. */
  | { verdict: 'context-dependent'; riskyWhenOwnerIncludes: string; coverage: 'denylist' | 'path-regex'; why: string };

/**
 * One entry per distinct field name this file's scan has ever found. `field: null` entries
 * (unresolved type references) are asserted to never occur — see the "no unresolved type
 * references" test — so they carry no verdict here.
 */
const FIELD_CLASSIFICATION: Record<string, Verdict> = {
  // ---- already in the denylist, and genuinely produced by a real emitter -------------------
  backend: { verdict: 'risky', why: 'the agent CLI backend a sessionId only resumes against on this host' },
  cwd: { verdict: 'risky', why: 'a filesystem location on the origin host' },
  sessionId: { verdict: 'risky', why: 'the exact opaque resume handle the docblock names first' },

  // ---- NOT currently in the denylist — real findings, see the failing assertion below -------
  spoolDir: {
    verdict: 'risky',
    why:
      'the absolute local directory backing a detached broker session (`core/run-spool.ts`) — ' +
      '`controlSocketPath(spoolDir)` derives a UNIX control-socket path FROM this value, so it is ' +
      'not just informational, it is the coordinate a process on the origin host would need to ' +
      'reach that broker. Produced at run.ts:4060 (`run.step.retried_cold_broker` metric) and ' +
      'run.ts:4658/4664 (cold-broker retry). Not covered by `LOCAL_PATH_RE` either on a spoke ' +
      'whose checkout root sits outside `/Users`, `/home`, `/root`, `~` (e.g. `/opt/...`, ' +
      '`/var/lib/...` — both real paths named in this repo\'s own deploy doctrine).',
  },
  // CORRECTED 2026-08-23, twice:
  //  (1) The producer fix — `run.ts:3671`/`:5184` no longer spread `saved` (a `PersistedAttachment`)
  //      into an event; both sites now project `{ name: saved.name, url: saved.url }` explicitly.
  //      `PersistedAttachment` was therefore removed from `KNOWN_SPREAD_TYPES` above (nothing
  //      spreads it — keeping the entry would itself be the hand-typed, stale-snapshot problem
  //      this file exists to avoid), which means NO occurrence in today's inventory carries
  //      `ownerType` including `'PersistedAttachment'`. This entry's `riskyWhenOwnerIncludes`
  //      branch is therefore DORMANT, not deleted — kept, and deliberately not downgraded to a
  //      plain `'safe'` verdict, as a regression guard: if `...saved` (or any other spread of a
  //      type carrying an absolute-local-path field under the bare name `path`) is ever
  //      reintroduced, `KNOWN_SPREAD_TYPES` must be updated for it to resolve at all (forced by
  //      the "every spread is accounted for" test, since `'saved'` was also dropped from
  //      `knownIdentifiers`), and THIS entry is what re-activates the moment it does.
  //  (2) Defence in depth, independent of (1): `LOCAL_PATH_RE` was ALSO widened to recognize this
  //      project's own deploy roots (`/opt/…`, `/var/…`, `/srv/…`, alongside the pre-existing
  //      home-directory roots) — see relay.ts's corrected docblocks. So even if `path`'s
  //      `coverage: 'path-regex'` branch were live today, it would pass: the value-shape probe
  //      below exercises this independently of whether any current call site produces the field.
  path: {
    verdict: 'context-dependent',
    riskyWhenOwnerIncludes: 'PersistedAttachment',
    coverage: 'path-regex',
    why:
      '`PersistedAttachment.path` (formerly run.ts:6145 via `{ ...saved }`, now eliminated at the ' +
      'producer — see the correction note above) is an absolute local path under wherever a node\'s ' +
      '`.ai/cezar` data directory lives — the same class as `worktreePath`/`cwd`, just carried in a ' +
      'value rather than named by a denylistable key. `FileDiff.path`/`ToolLocation.path` are the ' +
      'SAME bare key on a repo-relative path (needed for a "jump to file" affordance, never has a ' +
      'leading slash, so `LOCAL_PATH_RE` cannot touch it either way) and must stay safe — a blanket ' +
      '`LOCAL_AFFORDANCE_KEYS.add(\'path\')` would have silently broken that instead of fixing the ' +
      'leak. Residual, unchanged: a deploy root outside {Users, home, root, opt, var, srv, ~, ' +
      'Windows, WSL} still slips through unredacted — see the "path-regex coverage" behavioral test ' +
      'below, which probes exactly the roots `LOCAL_PATH_RE` currently recognizes, no more.',
  },

  // ---- everything else this scan found: reviewed, not local-machine affordances -------------
  type: { verdict: 'safe', why: 'event-kind discriminant' },
  stepId: { verdict: 'safe', why: 'an id scoped to the run\'s own event stream, not a filesystem/session coordinate' },
  name: { verdict: 'safe', why: 'a display/tool/metric name string (PersistedAttachment.name is a generated filename, not a path)' },
  kind: { verdict: 'safe', why: 'small closed enum (item kind / permission-option kind / literal "agent")' },
  iteration: { verdict: 'safe', why: 'a retry counter number' },
  text: { verdict: 'safe', why: 'free text; embedded local paths are caught by LOCAL_PATH_RE regardless of key' },
  imageCount: { verdict: 'safe', why: 'a number' },
  images: { verdict: 'safe', why: 'array of relative `/api/v1/...` URLs (see `url` below)' },
  message: { verdict: 'safe', why: 'free text, same regex coverage as `text`' },
  runId: { verdict: 'safe', why: 'the id of the run the viewer is already subscribed to' },
  limit: { verdict: 'safe', why: 'a resource-kill limit number' },
  at: { verdict: 'safe', why: 'a timestamp number' },
  status: { verdict: 'safe', why: 'small closed enum (ToolStatus / PlanStatus / step status literal)' },
  provider: {
    verdict: 'safe',
    why:
      'a provider NAME (e.g. an MCP provider needing re-auth), not an agent backend — lower ' +
      'confidence than the rest of this table; see the delivery report for the open question of ' +
      'whether `POST /providers/:id/retry` proxies cross-node for a relayed run',
  },
  authFailureId: {
    verdict: 'safe',
    why:
      'an id into `ProviderAuthService`\'s in-memory, per-process runtime state, paired with ' +
      '`provider` above — same lower-confidence flag, same open question, see the report',
  },
  workflow: { verdict: 'safe', why: 'a workflow NAME string (e.g. "quick-task"), not a path' },
  requestedRunner: {
    verdict: 'safe',
    why:
      'the engine pill\'s choice (RunnerId — a provider name like "codex"), from `run.workflow.selected` ' +
      '(`.ai/specs/2026-08-24-codex-only-default-workflow.md`). Unlike `backend` above, it is not ' +
      'paired with a `sessionId` in the same event, so it names a provider without naming a resumable ' +
      'handle to reach it with.',
  },
  stepCount: { verdict: 'safe', why: 'a number (workflow.steps.length), from `run.workflow.selected`' },
  plannedRunner: {
    verdict: 'safe',
    why:
      'a provider name (RunnerId) a step was pinned to, from `run.step.runner_downgraded` — same ' +
      'reasoning as `requestedRunner`: no `sessionId` shares this event.',
  },
  actualRunner: {
    verdict: 'safe',
    why: 'a provider name (RunnerId) a step ran on instead, from the same `run.step.runner_downgraded` event as `plannedRunner`',
  },
  attempt: { verdict: 'safe', why: 'a retry counter number' },
  command: { verdict: 'safe', why: 'a shell command string; free-text regex coverage applies' },
  exitCode: { verdict: 'safe', why: 'a number' },
  elapsedMs: { verdict: 'safe', why: 'a number' },
  tokensUsed: { verdict: 'safe', why: 'a number' },
  reason: { verdict: 'safe', why: 'small closed enum (AgentStopReason / StopReason)' },
  error: { verdict: 'safe', why: 'free text; regex coverage applies' },
  stopReason: { verdict: 'safe', why: 'small closed enum (StopReason)' },
  id: { verdict: 'safe', why: 'an item/tool-call id scoped to the run\'s own stream' },
  tool: { verdict: 'safe', why: 'a tool name string' },
  input: { verdict: 'safe', why: 'arbitrary tool input (unknown); regex coverage applies to any embedded path text' },
  toolCallId: { verdict: 'safe', why: 'an id scoped to the run\'s own stream' },
  result: { verdict: 'safe', why: 'tool result text; regex coverage applies' },
  isError: { verdict: 'safe', why: 'a boolean' },
  mediaType: { verdict: 'safe', why: 'a MIME type string' },
  data: { verdict: 'safe', why: 'base64 payload bytes' },
  usd: { verdict: 'safe', why: 'a number' },
  model: { verdict: 'safe', why: 'a model name string — every node can serve any model name' },
  tools: { verdict: 'safe', why: 'array of tool NAMES available to the session, not paths' },
  fatal: { verdict: 'safe', why: 'a boolean' },
  turnId: { verdict: 'safe', why: 'an id scoped to the run\'s own stream' },
  usage: { verdict: 'safe', why: 'nested TokenUsage object, recursed and classified field-by-field' },
  output: { verdict: 'safe', why: 'arbitrary tool/turn output text; regex coverage applies' },
  cacheRead: { verdict: 'safe', why: 'a number' },
  cacheWrite: { verdict: 'safe', why: 'a number' },
  reasoning: { verdict: 'safe', why: 'a number (token count)' },
  total: { verdict: 'safe', why: 'a number' },
  contextWindow: { verdict: 'safe', why: 'a number' },
  costUsd: { verdict: 'safe', why: 'a number' },
  contextTokens: { verdict: 'safe', why: 'a number' },
  blockCounts: { verdict: 'safe', why: 'nested ClaudeBlockCounts object, all-numeric once recursed' },
  thinking: { verdict: 'safe', why: 'a number' },
  thinkingWithheld: { verdict: 'safe', why: 'a number' },
  toolUse: { verdict: 'safe', why: 'a number' },
  redactedThinking: { verdict: 'safe', why: 'a number' },
  serverToolUse: { verdict: 'safe', why: 'a number' },
  other: { verdict: 'safe', why: 'a number' },
  childBlockCounts: { verdict: 'safe', why: 'same shape as blockCounts' },
  item: { verdict: 'safe', why: 'nested UiItem object, recursed and classified field-by-field' },
  role: { verdict: 'safe', why: 'small closed enum ("assistant" | "user")' },
  phase: { verdict: 'safe', why: 'small closed enum ("commentary" | "final")' },
  parentItemId: { verdict: 'safe', why: 'an id scoped to the run\'s own stream' },
  toolKind: { verdict: 'safe', why: 'small closed enum (icon/verb hint)' },
  title: { verdict: 'safe', why: 'display text' },
  diffs: { verdict: 'safe', why: 'array of FileDiff, recursed' },
  oldText: { verdict: 'safe', why: 'repo file content — portable across any checkout of the repo' },
  newText: { verdict: 'safe', why: 'repo file content — portable across any checkout of the repo' },
  unified: { verdict: 'safe', why: 'a unified diff of repo content — portable' },
  locations: { verdict: 'safe', why: 'array of ToolLocation, recursed' },
  line: { verdict: 'safe', why: 'a number' },
  itemId: { verdict: 'safe', why: 'an id scoped to the run\'s own stream' },
  field: { verdict: 'safe', why: 'small closed enum ("text" | "reasoning" | "output")' },
  delta: { verdict: 'safe', why: 'a streamed text chunk; regex coverage applies' },
  entries: { verdict: 'safe', why: 'array of PlanEntry, recursed' },
  content: { verdict: 'safe', why: 'plan-entry text' },
  priority: { verdict: 'safe', why: 'small closed enum' },
  activeForm: { verdict: 'safe', why: 'plan-entry display text' },
  requestId: { verdict: 'safe', why: 'an id scoped to the run\'s own interactive-question flow — the intended remote interaction surface, not a leak' },
  options: { verdict: 'safe', why: 'array (PermissionOption / UiAskOption), recursed' },
  label: { verdict: 'safe', why: 'display text' },
  optionId: { verdict: 'safe', why: 'an id scoped to the run\'s own stream' },
  questions: { verdict: 'safe', why: 'array of UiAskQuestion, recursed' },
  header: { verdict: 'safe', why: 'display text' },
  question: { verdict: 'safe', why: 'display text' },
  description: { verdict: 'safe', why: 'display text' },
  multiSelect: { verdict: 'safe', why: 'a boolean' },
  url: { verdict: 'safe', why: 'a relative `/api/v1/runs/.../images/...` path, resolved against a node base URL the cluster roster already discloses — not an additional secret' },
  site: { verdict: 'safe', why: 'small closed enum naming which account-fallback call site emitted the event ("explicit-reroute" | "pinned-step" | "pool")' },
  requestedRoute: { verdict: 'safe', why: 'an agent-route string ("account:<id>" / "pool:<provider>") naming a configured account slot, not a filesystem/session coordinate' },
  requestedProvider: { verdict: 'safe', why: 'a provider name string (e.g. "claude" / "codex")' },
  requestedAccount: { verdict: 'safe', why: 'an account key string (provider:profile), the same identifying shape as `requestedRoute` — not a credential or a resume handle' },
  selectedProvider: { verdict: 'safe', why: 'a provider name string, same as `requestedProvider`' },
  selectedAccount: { verdict: 'safe', why: 'an account key string, same as `requestedAccount`' },
  selectedTier: { verdict: 'safe', why: 'small closed enum ("runnable" | "waitable")' },
  cause: { verdict: 'safe', why: 'small closed enum ("quota" | "credentials" | "quota+credentials")' },
  skippedDisconnected: { verdict: 'safe', why: 'array of account key strings, same shape as `requestedAccount`' },
  actualAccount: { verdict: 'safe', why: 'an account key string, same as `requestedAccount`' },
};

// ============================================================================================
// Tests
// ============================================================================================

describe('cluster/relay — LOCAL_AFFORDANCE_KEYS source-derived inventory', () => {
  it('floor: finds a substantial, non-vacuous set of real call sites', () => {
    const { totalCallSites, literalKeys } = scanAppendEventCallSites(SRC_ROOT);
    // 127 at the time this test was written (78 direct .appendEvent/.emitEphemeral + ~49 via the
    // RunEvent-shaped emit(...) callback). A wide floor, not a pinned count — the point is that
    // this can never pass by accident the way an empty/near-empty result would.
    expect(totalCallSites).toBeGreaterThanOrEqual(70);
    for (const known of ['type', 'stepId', 'message', 'name', 'status', 'runId']) {
      expect(literalKeys.has(known), `expected literal key "${known}" to be found by the scan`).toBe(true);
    }
  });

  it('floor is not vacuous: the same scan over an EMPTY directory finds nothing', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'cez-relay-inventory-empty-'));
    try {
      const result = scanAppendEventCallSites(emptyDir);
      expect(result.totalCallSites).toBe(0);
      expect(result.literalKeys.size).toBe(0);
      // This is exactly the result that would make the floor assertion above pass FALSELY if it
      // were written as `>= 0` — proving the `>= 70` floor is doing real work, not decoration.
      expect(result.totalCallSites).toBeLessThan(70);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('every spread found at a real call site is either a known object-literal shape or in KNOWN_SPREAD_TYPES', () => {
    const { spreads } = scanAppendEventCallSites(SRC_ROOT);
    // CORRECTED 2026-08-23: 'saved' removed. It named `PersistedAttachment` at run.ts's two
    // image-event call sites until this fix — they now project `{ name, url }` explicitly
    // instead of `...saved` (closing the `PersistedAttachment.path` leak at the producer). If
    // `...saved` (or any other new bare-identifier spread) ever reappears, it must fail HERE as
    // unrecognized rather than being silently accepted — reintroducing a spread pattern that
    // once carried a local-machine affordance is exactly the kind of change this file exists to
    // force a review of.
    const knownIdentifiers = new Set(['event']);
    const unaccounted: string[] = [];
    for (const [exprText, provenances] of spreads) {
      const isKnownIdentifier = knownIdentifiers.has(exprText);
      // Conditional spreads with object-literal branches, e.g. `(stepId ? { stepId } : {})`, are
      // handled generically by parseObjectLiteral recursing into the literal branches directly —
      // scanAppendEventCallSites already folded THEIR keys into `literalKeys`, not `spreads`, so
      // reaching this loop as a spread at all means it is either a bare identifier or something
      // this scanner has never seen before.
      if (!isKnownIdentifier) {
        unaccounted.push(`"${exprText}" at ${[...provenances].join(', ')}`);
      }
    }
    expect(
      unaccounted,
      `unrecognized spread expression(s) at a RunEvent call site — classify the identifier's ` +
        `real type in KNOWN_SPREAD_TYPES before this can pass:\n${unaccounted.join('\n')}`,
    ).toEqual([]);
  });

  it('AgentEvent / UiEvent resolve with no unresolved type references', () => {
    const unresolved: string[] = [];
    for (const { file, type } of KNOWN_SPREAD_TYPES) {
      for (const f of flattenType(file, type)) {
        if (f.field === null) unresolved.push(`${type} (from ${file}): could not resolve "${f.unresolved}"`);
      }
    }
    expect(unresolved, `type resolution failed open:\n${unresolved.join('\n')}`).toEqual([]);
  });

  it('every inventoried field is classified, and every risky field is denylisted', () => {
    const { literalKeys } = scanAppendEventCallSites(SRC_ROOT);
    const allOccurrences: Array<{ field: string; ownerType: string }> = [];
    for (const [field, provenances] of literalKeys) {
      allOccurrences.push({ field, ownerType: `call-site literal (${[...provenances][0]})` });
    }
    for (const { file, type } of KNOWN_SPREAD_TYPES) {
      for (const f of flattenType(file, type)) {
        if (f.field !== null) allOccurrences.push({ field: f.field, ownerType: f.ownerType });
      }
    }

    const unclassified = new Set<string>();
    const notDenylisted: string[] = [];
    for (const { field, ownerType } of allOccurrences) {
      const verdict = FIELD_CLASSIFICATION[field];
      if (!verdict) {
        unclassified.add(field);
        continue;
      }
      if (verdict.verdict === 'risky' && !LOCAL_AFFORDANCE_KEYS.has(field)) {
        notDenylisted.push(`"${field}" (${ownerType}) — ${verdict.why}`);
      }
      if (verdict.verdict === 'context-dependent' && ownerType.includes(verdict.riskyWhenOwnerIncludes)) {
        if (verdict.coverage === 'denylist' && !LOCAL_AFFORDANCE_KEYS.has(field)) {
          notDenylisted.push(`"${field}" (${ownerType}) — ${verdict.why}`);
        }
        if (verdict.coverage === 'path-regex') {
          const failures = pathRegexCoverageFailures(field);
          if (failures.length > 0) {
            notDenylisted.push(
              `"${field}" (${ownerType}) — value-shape redaction failed for: ${failures.join('; ')} — ${verdict.why}`,
            );
          }
        }
      }
    }

    expect(
      [...unclassified],
      `field(s) found by the scan with no entry in FIELD_CLASSIFICATION — a new RunEvent field ` +
        `was added without the security review the relay.ts docblock requires. Add a reviewed ` +
        `entry (safe/risky/context-dependent) before this can pass:\n${[...unclassified].join(', ')}`,
    ).toEqual([]);

    expect(
      notDenylisted,
      `field(s) classified as a local-machine affordance but MISSING from LOCAL_AFFORDANCE_KEYS ` +
        `in relay.ts — a foreign run would currently relay these unredacted:\n` +
        notDenylisted.join('\n'),
    ).toEqual([]);
  });
});

/** The denylist under test — imported dynamically via a tiny re-export shim is unnecessary since
 *  relay.ts already exports `stripLocalAffordances`; the SET ITSELF is not exported (by design —
 *  the module docblock treats it as an internal detail), so the assertion above needs its
 *  membership indirectly: probe it through `stripLocalAffordances` once per candidate key. This
 *  keeps the test honest to the ACTUAL runtime behavior (what really gets dropped) rather than a
 *  second, possibly-diverging copy of the list. */
const LOCAL_AFFORDANCE_KEYS = {
  has(key: string): boolean {
    const probe = { seq: 1, ts: 't', type: 'note', [key]: 'PROBE_VALUE_' + key };
    const stripped = stripLocalAffordances(probe);
    return !(key in stripped);
  },
};

/** Every local-machine root `LOCAL_PATH_RE` is currently expected to recognize — home-directory
 *  roots plus this project's own known deploy roots. Kept as one list so a `coverage: 'path-regex'`
 *  classification and its behavioral test (below) probe exactly the same set: if `LOCAL_PATH_RE`
 *  is ever narrowed, both go red together instead of silently drifting apart. */
const KNOWN_LOCAL_PATH_ROOTS = ['/Users', '/home', '/root', '/opt', '/var', '/srv'] as const;

/** Probes (through the real, exported `stripLocalAffordances` — not a re-implementation of the
 *  regex) that a `coverage: 'path-regex'` field's value is redacted under every root above.
 *  Returns the roots that FAILED to redact, empty when fully covered. */
function pathRegexCoverageFailures(field: string): string[] {
  const failures: string[] = [];
  for (const root of KNOWN_LOCAL_PATH_ROOTS) {
    const value = `${root}/cezar/.ai/cezar/runs/r1-images/pasted-1.png`;
    const stripped = stripLocalAffordances({ seq: 1, ts: 't', type: 'note', [field]: value });
    if (stripped[field] !== '[local path redacted]') {
      failures.push(`${root} -> ${JSON.stringify(stripped[field])}`);
    }
  }
  return failures;
}

describe('cluster/relay — stripLocalAffordances behavioural coverage (independent of the scan above)', () => {
  it('removes every key currently classified risky, nested inside arrays and objects, without touching sibling data', () => {
    const riskyKeys = Object.entries(FIELD_CLASSIFICATION)
      .filter(([, v]) => v.verdict === 'risky')
      .map(([k]) => k);
    // These three are ALWAYS denylisted regardless of nesting position per relay.ts's own
    // docblock ("wherever they appear in the event tree") — confirmed still true today.
    expect(riskyKeys).toEqual(expect.arrayContaining(['backend', 'cwd', 'sessionId']));

    for (const key of riskyKeys) {
      const event = {
        seq: 1,
        ts: 't',
        type: 'note',
        [key]: 'top-level-value',
        nested: { [key]: 'nested-value', keep: 'kept' },
        list: [{ [key]: 'in-array-value', keep: 'kept-too' }, 'plain string element'],
      };
      const stripped = stripLocalAffordances(event) as Record<string, unknown>;
      expect(stripped, `top-level "${key}"`).not.toHaveProperty(key);
      expect((stripped.nested as Record<string, unknown>), `nested "${key}"`).not.toHaveProperty(key);
      expect((stripped.nested as Record<string, unknown>).keep).toBe('kept');
      const arr = stripped.list as unknown[];
      expect(arr[0], `in-array "${key}"`).not.toHaveProperty(key);
      expect((arr[0] as Record<string, unknown>).keep).toBe('kept-too');
      expect(arr[1]).toBe('plain string element');
    }
  });

  it('redacts a home-directory-shaped path in a value under a key the denylist does not name', () => {
    const event = {
      seq: 1,
      ts: 't',
      type: 'tool-result',
      result: 'wrote /Users/dev/workspace/cezar/.ai/cezar/runs/r1-images/pasted-1.png',
    };
    const stripped = stripLocalAffordances(event);
    expect(stripped.result).toBe('wrote [local path redacted]');
  });

  it('redacts this project\'s own deploy-root paths, not just home directories (spec D9a residual)', () => {
    // Defence in depth, independent of the run.ts producer fix (see KNOWN_SPREAD_TYPES's
    // correction note): prod-host runs its checkout from /opt/cezar and its state from
    // /var/lib/cezar (AGENTS.md), and any future field carrying an absolute path under one of
    // those roots — not just the now-fixed PersistedAttachment.path — must still be caught here.
    // Widened 2026-08-23 after the source-derived scan found the OLD regex (home directories
    // only) missed exactly this shape on this project's own production host.
    for (const root of KNOWN_LOCAL_PATH_ROOTS) {
      const event = {
        seq: 1,
        ts: 't',
        type: 'image',
        path: `${root}/cezar/.ai/cezar/runs/r1-images/pasted-1.png`,
      };
      const stripped = stripLocalAffordances(event);
      expect(stripped.path, `root ${root}`).toBe('[local path redacted]');
    }
  });

  it('leaves an API route, a markdown heading and repo-relative content untouched — the regex must stay narrow, not just wide', () => {
    // The module docblock is explicit that this narrowness is deliberate, not an oversight: a
    // wider match here (e.g. any leading slash, or a bare "var"/"opt"/"srv" substring with no
    // leading slash) would clobber exactly the repo-relative `path` FileDiff/ToolLocation rely
    // on, and the `url` field every image event carries.
    const event = {
      seq: 1,
      ts: 't',
      type: 'note',
      route: 'see /api/v1/cluster for the roster',
      // Contains "var" as a substring with no leading slash — must NOT be mistaken for the
      // `/var/…` root the widened regex now recognizes.
      heading: '## Variable naming conventions',
      relativePath: 'packages/cezar/src/cluster/relay.ts',
      url: '/api/v1/runs/r1/images/pasted-1.png',
    };
    const stripped = stripLocalAffordances(event);
    expect(stripped.route).toBe('see /api/v1/cluster for the roster');
    expect(stripped.heading).toBe('## Variable naming conventions');
    expect(stripped.relativePath).toBe('packages/cezar/src/cluster/relay.ts');
    expect(stripped.url).toBe('/api/v1/runs/r1/images/pasted-1.png');
  });
});
