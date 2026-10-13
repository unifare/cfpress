/**
 * CFPress template engine.
 *
 * A safe, dependency-free template language executed inside the Worker.
 * Cloudflare Workers forbid eval/new Function, so user templates are
 * *parsed into an AST* and interpreted here rather than executed as JS.
 *
 * Supported syntax:
 *   {{ expr }}                     output (HTML-escaped by default)
 *   {{{ expr }}}                   raw output (no escaping)
 *   {{#if expr}} ... {{else}} ... {{/if}}
 *   {{#unless expr}} ... {{/unless}}
 *   {{#each expr as item}} ... {{/each}}        (also `{{#each expr}}` -> `this`)
 *   {{@include "parts/card"}}
 *   {{@extends "base"}}
 *   {{@section "content"}} ... {{/section}}
 *   {{@query type="product" limit=6 order="created_at desc" as="products"}}
 *       ... body rendered once, `products` bound ...
 *   {{/query}}
 *   {{! comment }}
 *
 * Expressions are a deliberately small subset: literals, variable paths,
 * property/index access, comparison, logical operators and a handful of
 * whitelisted helper calls. No assignment, no arbitrary function calls.
 */

// ---------------------------------------------------------------------------
// Expression evaluator
// ---------------------------------------------------------------------------

type Scope = Record<string, unknown>;

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

/** Tokenize a single expression string into a flat token list. */
type Tok =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "null" }
  | { t: "id"; v: string }
  | { t: "op"; v: string }
  | { t: "punc"; v: string };

function lexExpr(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    // string literal
    if (c === '"' || c === "'") {
      const quote = c;
      let out = "";
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\" && i + 1 < n) {
          const nx = src[i + 1];
          out += nx === "n" ? "\n" : nx === "t" ? "\t" : nx;
          i += 2;
          continue;
        }
        out += src[i++];
      }
      if (i >= n) throw new TemplateError("Unterminated string literal");
      i++; // closing quote
      toks.push({ t: "str", v: out });
      continue;
    }
    // number literal
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i;
      while (j < n && /[0-9.]/.test(src[j])) j++;
      const raw = src.slice(i, j);
      if ((raw.match(/\./g) ?? []).length > 1) throw new TemplateError(`Bad number: ${raw}`);
      toks.push({ t: "num", v: Number(raw) });
      i = j;
      continue;
    }
    // loop metadata: @index / @first / @last
    if (c === "@") {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      if (j === i + 1) throw new TemplateError("Expected a name after '@'");
      toks.push({ t: "id", v: src.slice(i, j) });
      i = j;
      continue;
    }
    // identifier / keyword
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
      const word = src.slice(i, j);
      if (word === "true" || word === "false") toks.push({ t: "bool", v: word === "true" });
      else if (word === "null" || word === "undefined") toks.push({ t: "null" });
      else toks.push({ t: "id", v: word });
      i = j;
      continue;
    }
    // multi-char operators
    const three = src.slice(i, i + 3);
    if (three === "===" || three === "!==") {
      toks.push({ t: "op", v: three });
      i += 3;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["==", "!=", ">=", "<=", "&&", "||"].includes(two)) {
      toks.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if (["!", ">", "<"].includes(c)) {
      toks.push({ t: "op", v: c });
      i++;
      continue;
    }
    if (["(", ")", "[", "]", ",", "."].includes(c)) {
      toks.push({ t: "punc", v: c });
      i++;
      continue;
    }
    throw new TemplateError(`Unexpected character in expression: ${c}`);
  }
  return toks;
}

class ExprParser {
  private pos = 0;
  constructor(private toks: Tok[]) {}

  private peek(): Tok | undefined {
    return this.toks[this.pos];
  }
  private eat(v?: string): Tok | undefined {
    const t = this.toks[this.pos];
    if (!t) return undefined;
    if (v !== undefined) {
      const tv = t.t === "op" || t.t === "punc" ? t.v : t.t === "id" ? t.v : undefined;
      if (tv !== v) return undefined;
    }
    this.pos++;
    return t;
  }

  parse(): Node {
    const node = this.parseOr();
    if (this.pos !== this.toks.length) throw new TemplateError("Trailing tokens in expression");
    return node;
  }

  private parseOr(): Node {
    let left = this.parseAnd();
    while (this.eat("||")) left = { k: "binary", op: "||", left, right: this.parseAnd() };
    return left;
  }
  private parseAnd(): Node {
    let left = this.parseEquality();
    while (this.eat("&&")) left = { k: "binary", op: "&&", left, right: this.parseEquality() };
    return left;
  }
  private parseEquality(): Node {
    let left = this.parseRelational();
    for (;;) {
      if (this.eat("==")) left = { k: "binary", op: "==", left, right: this.parseRelational() };
      else if (this.eat("!=")) left = { k: "binary", op: "!=", left, right: this.parseRelational() };
      else if (this.eat("===")) left = { k: "binary", op: "===", left, right: this.parseRelational() };
      else if (this.eat("!==")) left = { k: "binary", op: "!==", left, right: this.parseRelational() };
      else return left;
    }
  }
  private parseRelational(): Node {
    let left = this.parseUnary();
    for (;;) {
      if (this.eat(">")) left = { k: "binary", op: ">", left, right: this.parseUnary() };
      else if (this.eat("<")) left = { k: "binary", op: "<", left, right: this.parseUnary() };
      else if (this.eat(">=")) left = { k: "binary", op: ">=", left, right: this.parseUnary() };
      else if (this.eat("<=")) left = { k: "binary", op: "<=", left, right: this.parseUnary() };
      else return left;
    }
  }
  private parseUnary(): Node {
    if (this.eat("!")) return { k: "unary", op: "!", arg: this.parseUnary() };
    return this.parsePostfix();
  }
  private parsePostfix(): Node {
    let node = this.parsePrimary();
    for (;;) {
      if (this.eat(".")) {
        const id = this.eat();
        if (!id || id.t !== "id") throw new TemplateError("Expected property name after '.'");
        node = { k: "member", obj: node, key: { k: "literal", value: id.v }, computed: false };
      } else if (this.eat("[")) {
        const idx = this.parseOr();
        if (!this.eat("]")) throw new TemplateError("Expected ']'");
        node = { k: "member", obj: node, key: idx, computed: true };
      } else {
        return node;
      }
    }
  }
  private parsePrimary(): Node {
    const t = this.peek();
    if (!t) throw new TemplateError("Unexpected end of expression");
    if (t.t === "num" || t.t === "str" || t.t === "bool") {
      this.pos++;
      return { k: "literal", value: t.v };
    }
    if (t.t === "null") {
      this.pos++;
      return { k: "literal", value: null };
    }
    if (t.t === "id") {
      this.pos++;
      // whitelisted helper call
      if (this.peek()?.t === "punc" && (this.peek() as any).v === "(") {
        this.pos++;
        const args: Node[] = [];
        if (!(this.peek()?.t === "punc" && (this.peek() as any).v === ")")) {
          for (;;) {
            args.push(this.parseOr());
            if (this.eat(",")) continue;
            break;
          }
        }
        if (!this.eat(")")) throw new TemplateError("Expected ')' after helper arguments");
        return { k: "call", name: t.v, args };
      }
      return { k: "path", name: t.v };
    }
    if (t.t === "punc" && t.v === "(") {
      this.pos++;
      const inner = this.parseOr();
      if (!this.eat(")")) throw new TemplateError("Expected ')'");
      return inner;
    }
    throw new TemplateError(`Unexpected token in expression: ${JSON.stringify(t)}`);
  }
}

export type Node =
  | { k: "literal"; value: unknown }
  | { k: "path"; name: string }
  | { k: "member"; obj: Node; key: Node; computed: boolean }
  | { k: "unary"; op: string; arg: Node }
  | { k: "binary"; op: string; left: Node; right: Node }
  | { k: "call"; name: string; args: Node[] };

const exprCache = new Map<string, Node>();

export function parseExpression(src: string): Node {
  const cached = exprCache.get(src);
  if (cached) return cached;
  const node = new ExprParser(lexExpr(src)).parse();
  if (exprCache.size > 2000) exprCache.clear();
  exprCache.set(src, node);
  return node;
}

// Template-context helpers. Deliberately tiny and side-effect free.
// Created with a null prototype so no built-in method can leak through a
// name collision, and frozen so templates cannot mutate the registry.
const HELPERS: Record<string, (args: unknown[]) => unknown> = Object.freeze(
  Object.assign(Object.create(null), {
  // array/string length
  len: (a: unknown[]) => {
    const v = a[0];
    if (Array.isArray(v)) return v.length;
    if (typeof v === "string") return v.length;
    if (v && typeof v === "object") return Object.keys(v as object).length;
    return 0;
  },
  // truthiness-based default
  default: (a: unknown[]) => (isTruthy(a[0]) ? a[0] : a[1]),
  // lowercase / uppercase
  lower: (a: unknown[]) => String(a[0] ?? "").toLowerCase(),
  upper: (a: unknown[]) => String(a[0] ?? "").toUpperCase(),
  // truncate to N chars
  truncate: (a: unknown[]) => {
    const s = String(a[0] ?? "");
    const max = Number(a[1] ?? 100);
    return s.length > max ? s.slice(0, max) + "…" : s;
  },
  // join an array with a separator
  join: (a: unknown[]) => (Array.isArray(a[0]) ? a[0].join(String(a[1] ?? ", ")) : ""),
  // numeric formatting with thousands separators
  number: (a: unknown[]) => {
    const v = Number(a[0]);
    if (!Number.isFinite(v)) return "";
    return v.toLocaleString("en-US");
  },
  // ISO date from unix seconds
  date: (a: unknown[]) => {
    const secs = Number(a[0]);
    if (!Number.isFinite(secs)) return "";
    return new Date(secs * 1000).toISOString().slice(0, 10);
  },
  // membership test
  contains: (a: unknown[]) => {
    const hay = a[0];
    const needle = a[1];
    if (Array.isArray(hay)) return hay.some((x) => x === needle);
    return String(hay ?? "").includes(String(needle ?? ""));
  },
  })
);

/**
 * Property names that must never be reachable from a template. Blocking these
 * stops a template from climbing into the prototype chain and obtaining a real
 * function object.
 */
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function safeGet(obj: unknown, key: unknown): unknown {
  if (obj === null || obj === undefined) return undefined;
  const k = String(key);
  if (FORBIDDEN_KEYS.has(k)) return undefined;
  if (typeof obj === "object" || typeof obj === "function") {
    return (obj as Record<string, unknown>)[k];
  }
  return undefined;
}

/** Look up a dotted path from the root scope, e.g. `post.meta.price`. */
function resolvePath(name: string, scope: Scope): unknown {
  const parts = name.split(".");
  let cur: unknown = safeGet(scope, parts[0]);
  for (let i = 1; i < parts.length; i++) {
    cur = safeGet(cur, parts[i]);
    if (cur === undefined) return undefined;
  }
  return cur;
}

function isTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

export function evaluate(node: Node, scope: Scope): unknown {
  switch (node.k) {
    case "literal":
      return node.value;
    case "path":
      if (node.name === "this" || node.name === ".") return scope["this"];
      return resolvePath(node.name, scope);
    case "member": {
      const obj = evaluate(node.obj, scope);
      const key = evaluate(node.key, scope);
      return safeGet(obj, key);
    }
    case "unary":
      return node.op === "!" ? !isTruthy(evaluate(node.arg, scope)) : undefined;
    case "binary": {
      const l = evaluate(node.left, scope);
      // short-circuit
      if (node.op === "&&") return isTruthy(l) ? evaluate(node.right, scope) : l;
      if (node.op === "||") return isTruthy(l) ? l : evaluate(node.right, scope);
      const r = evaluate(node.right, scope);
      switch (node.op) {
        case "==":
          // eslint-disable-next-line eqeqeq
          return l == r;
        case "!=":
          // eslint-disable-next-line eqeqeq
          return l != r;
        case "===":
          return l === r;
        case "!==":
          return l !== r;
        case ">":
          return comparable(l, r, (a, b) => a > b);
        case "<":
          return comparable(l, r, (a, b) => a < b);
        case ">=":
          return comparable(l, r, (a, b) => a >= b);
        case "<=":
          return comparable(l, r, (a, b) => a <= b);
        default:
          return undefined;
      }
    }
    case "call": {
      // Only helpers defined directly on our own frozen map are reachable.
      // An own-property check prevents `constructor()`, `__proto__()` and
      // friends from walking the prototype chain and reaching real code.
      if (!Object.prototype.hasOwnProperty.call(HELPERS, node.name)) {
        throw new TemplateError(`Unknown helper: ${node.name}`);
      }
      const fn = HELPERS[node.name];
      if (typeof fn !== "function") throw new TemplateError(`Unknown helper: ${node.name}`);
      return fn(node.args.map((a) => evaluate(a, scope)));
    }
  }
}

function comparable(l: unknown, r: unknown, cmp: (a: any, b: any) => boolean): boolean {
  if (typeof l === "number" && typeof r === "number") return cmp(l, r);
  const ls = String(l ?? "");
  const rs = String(r ?? "");
  const ln = Number(ls);
  const rn = Number(rs);
  if (Number.isFinite(ln) && Number.isFinite(rn) && ls.trim() !== "" && rs.trim() !== "") {
    return cmp(ln, rn);
  }
  return cmp(ls, rs);
}

// ---------------------------------------------------------------------------
// Template parser
// ---------------------------------------------------------------------------

export type TplNode =
  | { k: "text"; value: string }
  | { k: "output"; expr: Node; raw: boolean; source: string }
  | { k: "if"; test: Node; consequent: TplNode[]; alternate: TplNode[] }
  | { k: "each"; list: Node; item: string; indexVar: string | null; body: TplNode[]; alternate: TplNode[] }
  | { k: "include"; name: string }
  | { k: "query"; params: Record<string, string | number>; asVar: string; body: TplNode[] }
  /**
   * A section slot. In a child template `{{@section "x"}}...{{/section}}`
   * *defines* a named block; in a parent/layout `{{@section "x"}}` (no body)
   * *marks where that block is emitted*. Both forms produce this node; the
   * `body` is null for the slot form.
   */
  | { k: "section"; name: string; body: TplNode[] | null };

export interface ParsedTemplate {
  nodes: TplNode[];
  extendsName: string | null;
  sections: Record<string, TplNode[]>;
}

const TAG_RE = /\{\{\{?[\s\S]*?\}\}\}?/g;

interface RawTag {
  inner: string;
  raw: boolean;
}

/** Split source into literal text and tag descriptors. */
function splitTags(src: string): Array<{ text: string } | { tag: RawTag }> {
  const out: Array<{ text: string } | { tag: RawTag }> = [];
  let last = 0;
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(src))) {
    if (m.index > last) out.push({ text: src.slice(last, m.index) });
    const full = m[0];
    const raw = full.startsWith("{{{");
    const inner = raw ? full.slice(3, -3) : full.slice(2, -2);
    out.push({ tag: { inner: inner.trim(), raw } });
    last = m.index + full.length;
  }
  if (last < src.length) out.push({ text: src.slice(last) });
  return out;
}

/** Parse `key="value"` style attributes used by @query. */
function parseAttrs(src: string): Record<string, string | number> {
  const attrs: Record<string, string | number> = {};
  const re = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const key = m[1];
    const val = m[2] ?? m[3] ?? m[4] ?? "";
    attrs[key] = /^-?\d+(\.\d+)?$/.test(val) ? Number(val) : val;
  }
  return attrs;
}

interface ParseState {
  tokens: Array<{ text: string } | { tag: RawTag }>;
  pos: number;
}

/**
 * Scan forward from the current position to see whether a `{{/name}}` closer
 * appears before the enclosing block ends. Used to distinguish a section
 * *definition* (`{{@section "x"}}...{{/section}}`) from a section *slot*
 * (`{{@section "x"}}`) inside a layout template.
 */
function hasMatchingClose(st: ParseState, name: string): boolean {
  let depth = 1;
  for (let i = st.pos; i < st.tokens.length; i++) {
    const tok = st.tokens[i];
    if (!("tag" in tok)) continue;
    const inner = tok.tag.inner;
    // Another opener of the same kind deepens the nesting.
    if (inner.startsWith(`@${name}`) || inner.startsWith(`#${name}`)) depth++;
    else if (inner === `/${name}`) {
      depth--;
      if (depth === 0) return true;
    }
  }
  return false;
}

/**
 * Parse a token stream into nodes, stopping when a closing tag in `stops`
 * is reached. Returns the nodes and the tag that terminated the block.
 */
function parseNodes(
  st: ParseState,
  stops: string[],
  ctx: { extendsName: string | null; sections: Record<string, TplNode[]>; currentSection: string | null }
): { nodes: TplNode[]; stop: string | null } {
  const nodes: TplNode[] = [];
  while (st.pos < st.tokens.length) {
    const tok = st.tokens[st.pos];
    if ("text" in tok) {
      if (tok.text) nodes.push({ k: "text", value: tok.text });
      st.pos++;
      continue;
    }
    const { inner, raw } = tok.tag;
    // closing tag, or a bare `{{else}}` which acts as a block separator
    if (inner.startsWith("/")) {
      const name = inner.slice(1).trim();
      if (stops.includes(name)) {
        st.pos++;
        return { nodes, stop: name };
      }
      throw new TemplateError(`Unexpected closing tag {{/${name}}}`);
    }
    if (inner === "else" && stops.includes("else")) {
      st.pos++;
      return { nodes, stop: "else" };
    }
    if (inner.startsWith("!")) {
      st.pos++;
      continue; // comment
    }
    st.pos++;

    if (inner.startsWith("@extends")) {
      const m = inner.match(/^@extends\s+(.+)$/);
      if (!m) throw new TemplateError("Malformed @extends");
      ctx.extendsName = String(evaluate(parseExpression(m[1].trim()), {}));
      continue;
    }
    if (inner.startsWith("@section")) {
      const m = inner.match(/^@section\s+(.+)$/);
      if (!m) throw new TemplateError("Malformed @section");
      const sectionName = String(evaluate(parseExpression(m[1].trim()), {}));
      // A section is a *definition* when a matching `{{/section}}` exists ahead
      // before any other block opener; otherwise it is a slot in a layout.
      if (hasMatchingClose(st, "section")) {
        const prev = ctx.currentSection;
        ctx.currentSection = sectionName;
        const res = parseNodes(st, ["section"], ctx);
        ctx.currentSection = prev;
        if (res.stop === null) throw new TemplateError("Unclosed block: {{@section}}");
        ctx.sections[sectionName] = res.nodes;
        nodes.push({ k: "section", name: sectionName, body: res.nodes });
      } else {
        nodes.push({ k: "section", name: sectionName, body: null });
      }
      continue;
    }
    if (inner.startsWith("@include")) {
      const m = inner.match(/^@include\s+(.+)$/);
      if (!m) throw new TemplateError("Malformed @include");
      nodes.push({ k: "include", name: String(evaluate(parseExpression(m[1].trim()), {})) });
      continue;
    }
    if (inner.startsWith("@query")) {
      const rest = inner.slice("@query".length).trim();
      const attrs = parseAttrs(rest);
      const asVar = String(attrs.as ?? "results");
      const params: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(attrs)) if (k !== "as") params[k] = v;
      const res = parseNodes(st, ["query"], ctx);
      if (res.stop === null) throw new TemplateError("Unclosed block: {{@query}}");
      nodes.push({ k: "query", params, asVar, body: res.nodes });
      continue;
    }
    if (inner.startsWith("#if")) {
      const test = parseExpression(inner.slice(3).trim());
      const cons = parseNodes(st, ["if", "else"], ctx);
      if (cons.stop === null) throw new TemplateError("Unclosed block: {{#if}}");
      let alternate: TplNode[] = [];
      if (cons.stop === "else") {
        const alt = parseNodes(st, ["if"], ctx);
        if (alt.stop === null) throw new TemplateError("Unclosed block: {{#if}} (alternate)");
        alternate = alt.nodes;
      }
      nodes.push({ k: "if", test, consequent: cons.nodes, alternate });
      continue;
    }
    if (inner.startsWith("#unless")) {
      const test = parseExpression(inner.slice(7).trim());
      const cons = parseNodes(st, ["unless"], ctx);
      if (cons.stop === null) throw new TemplateError("Unclosed block: {{#unless}}");
      nodes.push({ k: "if", test: { k: "unary", op: "!", arg: test }, consequent: cons.nodes, alternate: [] });
      continue;
    }
    if (inner.startsWith("#each")) {
      const rest = inner.slice(5).trim();
      let listExpr = rest;
      let item = "this";
      let indexVar: string | null = null;
      const asMatch = rest.match(/^(.*?)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)(?:\s*,\s*([A-Za-z_$][A-Za-z0-9_$]*))?$/);
      if (asMatch) {
        listExpr = asMatch[1];
        item = asMatch[2];
        indexVar = asMatch[3] ?? null;
      }
      const list = parseExpression(listExpr.trim());
      const res = parseNodes(st, ["each", "else"], ctx);
      if (res.stop === null) throw new TemplateError("Unclosed block: {{#each}}");
      let alternate: TplNode[] = [];
      if (res.stop === "else") {
        const alt = parseNodes(st, ["each"], ctx);
        if (alt.stop === null) throw new TemplateError("Unclosed block: {{#each}} (alternate)");
        alternate = alt.nodes;
      }
      nodes.push({ k: "each", list, item, indexVar, body: res.nodes, alternate });
      continue;
    }
    // plain output, or a stray block keyword
    if (inner.startsWith("#") || inner.startsWith("else") || inner === "else") {
      throw new TemplateError(`Unexpected block tag {{${inner}}}`);
    }
    nodes.push({ k: "output", expr: parseExpression(inner), raw, source: inner });
  }
  return { nodes, stop: null };
}

const parseCache = new Map<string, ParsedTemplate>();

export function parseTemplate(src: string): ParsedTemplate {
  const cached = parseCache.get(src);
  if (cached) return cached;
  const st: ParseState = { tokens: splitTags(src), pos: 0 };
  const ctx = { extendsName: null, sections: {} as Record<string, TplNode[]>, currentSection: null };
  const { nodes, stop } = parseNodes(st, [], ctx);
  if (stop) throw new TemplateError(`Unclosed block: ${stop}`);
  validateSections(nodes, ctx.sections, ctx.extendsName);
  const parsed: ParsedTemplate = { nodes, extendsName: ctx.extendsName, sections: ctx.sections };
  if (parseCache.size > 500) parseCache.clear();
  parseCache.set(src, parsed);
  return parsed;
}

/**
 * A `{{@section "x"}}` with no body is a slot, which only makes sense in a
 * layout. A template that mixes both forms, or that emits an unknown section
 * name, is almost always a typo — catch it here rather than silently emitting
 * an empty page.
 *
 * `extendsName` is what makes the slot/definition distinction decidable. The
 * parser guesses by scanning ahead for a matching `{{/section}}`, and when the
 * guess is wrong the failure is invisible: an unclosed section in a child reads
 * as a slot, contributes nothing to `@sections`, and the layout renders its slot
 * empty — HTTP 200, no exception, a blank page. But a child that `@extends`
 * *cannot* be a layout, so "this file extends something and still has slots" is
 * not a style problem, it is proof the closer is missing. That is a fact about
 * the file, not a text match, so it is safe to reject.
 */
function validateSections(nodes: TplNode[], defined: Record<string, TplNode[]>, extendsName: string | null): void {
  const slots: string[] = [];
  const walk = (list: TplNode[]) => {
    for (const n of list) {
      if (n.k === "section") {
        if (n.body === null) slots.push(n.name);
        else if (!(n.name in defined)) defined[n.name] = n.body;
      } else if (n.k === "if") {
        walk(n.consequent);
        walk(n.alternate);
      } else if (n.k === "each") {
        walk(n.body);
        walk(n.alternate);
      } else if (n.k === "query") {
        walk(n.body);
      }
    }
  };
  walk(nodes);
  // A file may not be both a child (defines sections) and a layout (has slots),
  // and a slot must correspond to something a child could provide.
  const hasDefinitions = Object.keys(defined).length > 0;
  if (slots.length > 0 && extendsName) {
    throw new TemplateError(
      `Template @extends "${extendsName}" but leaves section(s) unclosed: ${slots.join(", ")} — ` +
        `a child defines sections and never provides slots, so {{/section}} is missing`
    );
  }
  if (slots.length > 0 && hasDefinitions) {
    throw new TemplateError(
      `Template mixes section slots (${slots.join(", ")}) with section definitions — a file is either a layout or a child, not both`
    );
  }
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export interface RenderOptions {
  /** Resolve a template name to its source, for @include / @extends. */
  loadTemplate: (name: string) => Promise<string | null>;
  /**
   * Run a declarative content query. Receives the parsed params and the
   * current scope; returns an array of rows. Kept as a callback so the engine
   * stays free of DB concerns.
   */
  runQuery?: (params: Record<string, string | number>, scope: Scope) => Promise<unknown[]>;
  /** Hard cap on recursion depth to prevent cyclic includes. */
  maxDepth?: number;
}

export function escapeHtml(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function toDisplay(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

async function renderNodes(nodes: TplNode[], scope: Scope, opts: RenderOptions, depth: number): Promise<string> {
  if (depth > (opts.maxDepth ?? 12)) throw new TemplateError("Maximum template recursion depth exceeded");
  let out = "";
  for (const node of nodes) {
    switch (node.k) {
      case "text":
        out += node.value;
        break;
      case "output": {
        const value = evaluate(node.expr, scope);
        out += node.raw ? toDisplay(value) : escapeHtml(value);
        break;
      }
      case "if": {
        const branch = isTruthy(evaluate(node.test, scope)) ? node.consequent : node.alternate;
        out += await renderNodes(branch, scope, opts, depth + 1);
        break;
      }
      case "each": {
        const list = evaluate(node.list, scope);
        const arr = Array.isArray(list) ? list : list && typeof list === "object" ? Object.values(list) : [];
        if (arr.length === 0) {
          out += await renderNodes(node.alternate, scope, opts, depth + 1);
          break;
        }
        for (let i = 0; i < arr.length; i++) {
          const child: Scope = Object.create(scope) as Scope;
          child[node.item] = arr[i];
          child["this"] = arr[i];
          if (node.indexVar) child[node.indexVar] = i;
          child["@index"] = i;
          child["@first"] = i === 0;
          child["@last"] = i === arr.length - 1;
          out += await renderNodes(node.body, child, opts, depth + 1);
        }
        break;
      }
      case "include": {
        const src = await opts.loadTemplate(node.name);
        if (src === null) throw new TemplateError(`Included template not found: ${node.name}`);
        out += await renderTemplateSource(src, scope, opts, depth + 1);
        break;
      }
      case "query": {
        if (!opts.runQuery) throw new TemplateError("@query used but no query resolver is configured");
        const rows = await opts.runQuery(node.params, scope);
        const child: Scope = Object.create(scope) as Scope;
        child[node.asVar] = rows;
        out += await renderNodes(node.body, child, opts, depth + 1);
        break;
      }
      case "section": {
        // Slot form: emit the overriding section body if one was provided.
        const slotSource = (scope as Record<string, unknown>)["@sections"] as
          | Record<string, TplNode[]>
          | undefined;
        const override = slotSource?.[node.name];
        if (override) {
          out += await renderNodes(override, scope, opts, depth + 1);
        } else if (node.body) {
          // Definition form rendered standalone (e.g. res.render of the child).
          out += await renderNodes(node.body, scope, opts, depth + 1);
        }
        break;
      }
    }
  }
  return out;
}

/** Render an already-parsed template, resolving @extends chains. */
async function renderParsed(parsed: ParsedTemplate, scope: Scope, opts: RenderOptions, depth: number): Promise<string> {
  if (depth > (opts.maxDepth ?? 12)) throw new TemplateError("Maximum template recursion depth exceeded");
  if (!parsed.extendsName) {
    return renderNodes(parsed.nodes, scope, opts, depth);
  }
  // Resolve the parent chain: child -> ... -> root layout.
  const chain: ParsedTemplate[] = [parsed];
  let current = parsed;
  const seen = new Set<string>();
  while (current.extendsName) {
    if (seen.has(current.extendsName)) throw new TemplateError(`Circular @extends: ${current.extendsName}`);
    seen.add(current.extendsName);
    const src = await opts.loadTemplate(current.extendsName);
    if (src === null) throw new TemplateError(`Parent template not found: ${current.extendsName}`);
    current = parseTemplate(src);
    chain.push(current);
  }
  // Merge sections: the most-derived definition of each name wins.
  //
  // `chain` is ordered child-first, so walk it *backwards* (root first) and let
  // every later write overwrite. That puts the child last, which is the one that
  // must win. The previous form kept the first write instead and only special-
  // cased `i === 0`, so with three levels — `base` -> `layout` -> `single` — the
  // *root's* section beat the intermediate one, i.e. the least-derived won.
  // Nothing in the repo nests layouts yet, which is exactly why it went
  // unnoticed; a theme author trying it would have got the grandparent's copy.
  const merged: Record<string, TplNode[]> = {};
  for (let i = chain.length - 1; i >= 0; i--) {
    for (const [name, nodes] of Object.entries(chain[i].sections)) {
      merged[name] = nodes;
    }
  }
  const rootScope = Object.create(scope) as Scope;
  rootScope["@sections"] = merged;
  rootScope["@block"] = (name: string) => merged[name] ?? null;
  return renderNodes(chain[chain.length - 1].nodes, rootScope, opts, depth);
}

export async function renderTemplateSource(src: string, scope: Scope, opts: RenderOptions, depth = 0): Promise<string> {
  return renderParsed(parseTemplate(src), scope, opts, depth);
}

/** Render a named template (already resolved to source). */
export async function renderTemplate(
  source: string,
  data: Record<string, unknown>,
  opts: RenderOptions
): Promise<string> {
  return renderTemplateSource(source, data as Scope, opts, 0);
}
