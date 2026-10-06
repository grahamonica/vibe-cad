// Global variables and equations. Expressions are parsed by a small
// recursive-descent parser and evaluated over numbers only; nothing is ever
// passed to eval. Values are millimeters and degrees, like every dimension.
import type { Document, Feature, Variable } from "./types.ts";
import { solveSketch } from "./solver.ts";

type Expr =
  | { kind: "num"; value: number }
  | { kind: "var"; name: string }
  | { kind: "neg"; arg: Expr }
  | { kind: "bin"; op: "+" | "-" | "*" | "/" | "^"; a: Expr; b: Expr }
  | { kind: "call"; name: string; args: Expr[] };

const DEG = Math.PI / 180;
/** Unit suffixes allowed after a number; the result is in millimeters or degrees. */
const units: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8, deg: 1, rad: 1 / DEG };
const constants: Record<string, number> = { pi: Math.PI };
const functions: Record<string, [number, number, (...x: number[]) => number]> = {
  // Trigonometry works in degrees, like every angle in the document.
  sin: [1, 1, (x) => Math.sin(x * DEG)],
  cos: [1, 1, (x) => Math.cos(x * DEG)],
  tan: [1, 1, (x) => Math.tan(x * DEG)],
  asin: [1, 1, (x) => Math.asin(x) / DEG],
  acos: [1, 1, (x) => Math.acos(x) / DEG],
  atan: [1, 1, (x) => Math.atan(x) / DEG],
  atan2: [2, 2, (y, x) => Math.atan2(y, x) / DEG],
  sqrt: [1, 1, Math.sqrt],
  abs: [1, 1, Math.abs],
  round: [1, 1, Math.round],
  floor: [1, 1, Math.floor],
  ceil: [1, 1, Math.ceil],
  min: [1, 20, Math.min],
  max: [1, 20, Math.max],
};
const reserved = new Set([...Object.keys(units), ...Object.keys(constants), ...Object.keys(functions)]);

export function validVariableName(name: string) {
  return /^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(name) && !reserved.has(name);
}

/** Parse an expression such as `2 * wall + 0.5in` or `max(width / 3, 10)`. */
export function parseExpression(source: string): Expr {
  if (source.length > 400) throw Error("Expression is too long");
  const tokens = source.match(/\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?|[A-Za-z_][A-Za-z0-9_]*|°|[-+*/^(),]|\S/g) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const take = (t?: string) => {
    const tok = tokens[i];
    if (t !== undefined && tok !== t) throw Error(tok === undefined ? `Expected ${t}` : `Unexpected "${tok}" in expression`);
    i++;
    return tok;
  };
  const sum = (): Expr => {
    let e = product();
    while (peek() === "+" || peek() === "-") e = { kind: "bin", op: take() as "+" | "-", a: e, b: product() };
    return e;
  };
  const product = (): Expr => {
    let e = unary();
    while (peek() === "*" || peek() === "/") e = { kind: "bin", op: take() as "*" | "/", a: e, b: unary() };
    return e;
  };
  const unary = (): Expr => {
    if (peek() === "-") {
      take();
      return { kind: "neg", arg: unary() };
    }
    if (peek() === "+") take();
    return power();
  };
  const power = (): Expr => {
    const base = atom();
    // Right-associative; the exponent may be negative.
    return peek() === "^" ? (take(), { kind: "bin", op: "^", a: base, b: unary() }) : base;
  };
  const atom = (): Expr => {
    const tok = take();
    if (tok === undefined) throw Error("Expression is incomplete");
    if (tok === "(") {
      const e = sum();
      take(")");
      return e;
    }
    if (/^[\d.]/.test(tok)) {
      let value = Number(tok);
      if (!Number.isFinite(value)) throw Error(`Invalid number ${tok}`);
      const unit = peek();
      if (unit === "°") take();
      else if (unit !== undefined && unit in units) value *= units[take()];
      return { kind: "num", value };
    }
    if (/^[A-Za-z_]/.test(tok)) {
      if (tok in constants) return { kind: "num", value: constants[tok] };
      if (tok in functions) {
        take("(");
        const args: Expr[] = [];
        if (peek() !== ")") {
          args.push(sum());
          while (peek() === ",") (take(), args.push(sum()));
        }
        take(")");
        const [lo, hi] = functions[tok];
        if (args.length < lo || args.length > hi) throw Error(`${tok}() takes ${lo === hi ? lo : `${lo} to ${hi}`} argument${hi > 1 ? "s" : ""}`);
        return { kind: "call", name: tok, args };
      }
      if (tok in units) throw Error(`A unit must follow a number: ${tok}`);
      return { kind: "var", name: tok };
    }
    throw Error(`Unexpected "${tok}" in expression`);
  };
  const e = sum();
  if (i < tokens.length) throw Error(`Unexpected "${tokens[i]}" in expression`);
  return e;
}

export function referencedNames(e: Expr, out = new Set<string>()): Set<string> {
  if (e.kind === "var") out.add(e.name);
  else if (e.kind === "neg") referencedNames(e.arg, out);
  else if (e.kind === "bin") (referencedNames(e.a, out), referencedNames(e.b, out));
  else if (e.kind === "call") for (const a of e.args) referencedNames(a, out);
  return out;
}

function evaluate(e: Expr, scope: Map<string, number>): number {
  switch (e.kind) {
    case "num":
      return e.value;
    case "var": {
      const v = scope.get(e.name);
      if (v === undefined) throw Error(`Unknown variable ${e.name}`);
      return v;
    }
    case "neg":
      return -evaluate(e.arg, scope);
    case "bin": {
      const a = evaluate(e.a, scope),
        b = evaluate(e.b, scope);
      if (e.op === "/" && b === 0) throw Error("Division by zero in expression");
      return e.op === "+" ? a + b : e.op === "-" ? a - b : e.op === "*" ? a * b : e.op === "/" ? a / b : a ** b;
    }
    case "call":
      return functions[e.name][2](...e.args.map((a) => evaluate(a, scope)));
  }
}

/** Evaluate an expression against already-resolved variables. */
export function evaluateExpression(source: string, scope: Map<string, number>): number {
  const value = evaluate(parseExpression(source), scope);
  if (!Number.isFinite(value)) throw Error(`Expression ${source} has no finite value`);
  return value;
}

/** Values of every variable, in dependency order. Circular references are rejected. */
export function resolveVariables(variables: Variable[]): Map<string, number> {
  const byName = new Map(variables.map((v) => [v.name, v]));
  const scope = new Map<string, number>(),
    visiting: string[] = [];
  const visit = (name: string) => {
    if (scope.has(name)) return;
    const v = byName.get(name);
    if (!v) throw Error(`Unknown variable ${name}`);
    if (visiting.includes(name)) throw Error(`Circular variable reference: ${[...visiting.slice(visiting.indexOf(name)), name].join(" → ")}`);
    visiting.push(name);
    const expr = parseExpression(v.expression);
    for (const dep of referencedNames(expr)) visit(dep);
    visiting.pop();
    const value = evaluate(expr, scope);
    if (!Number.isFinite(value)) throw Error(`${name} has no finite value`);
    scope.set(name, value);
  };
  for (const v of variables) visit(v.name);
  return scope;
}

const positive = ["distance", "radius", "diameter", "spacing", "thickness", "counterboreDiameter", "counterboreDepth", "depth", "length", "bendRadius", "pitch"];
/** Set one numeric feature parameter after checking it is in range. */
export function setFeatureDimension(f: Feature, key: string, value: number) {
  if (typeof f.params[key] !== "number") throw Error(`Unknown numeric dimension ${key} on ${f.name}`);
  if (positive.includes(key) && value <= 0) throw Error(`${f.name}: ${key} must be positive`);
  if (key === "kFactor" && !(value >= 0 && value <= 1)) throw Error("K-factor must be between 0 and 1");
  if (f.type === "flange" && key === "angle" && !(value > 0 && value <= 180)) throw Error("Flange angle must be between 0 and 180 degrees");
  if (key === "count" && (!Number.isInteger(value) || value < 2 || value > 50)) throw Error("Pattern count must be an integer from 2 to 50");
  if (f.type === "moveFace" && key === "offset" && (value === 0 || Math.abs(value) > 10000)) throw Error("Move Face offset must be non-zero and within ±10000 mm");
  f.params[key] = value;
}

/**
 * Evaluate variables and write every equation-driven dimension into the
 * document, re-solving sketches whose dimensions changed. Runs inside each
 * transaction, so an equation that cannot be satisfied rejects the edit.
 */
export function applyEquations(doc: Document) {
  const variables = doc.variables ?? [];
  const bound = doc.sketches.some((s) => s.constraints.some((c) => c.expression)) || doc.features.some((f) => f.expressions && Object.keys(f.expressions).length);
  if (!variables.length && !bound) return;
  const scope = resolveVariables(variables);
  for (const v of variables) v.value = scope.get(v.name)!;
  for (const sk of doc.sketches) {
    let changed = false;
    for (const c of sk.constraints) {
      if (!c.expression) continue;
      const value = evaluateExpression(c.expression, scope);
      if (["length", "radius", "diameter", "offset"].includes(c.type) && value <= 0) throw Error(`${sk.name}: ${c.expression} must be positive`);
      if (c.value !== value) (c.value = value), (changed = true);
    }
    if (changed) solveSketch(sk);
  }
  for (const f of doc.features)
    for (const [key, expression] of Object.entries(f.expressions ?? {})) {
      const value = evaluateExpression(expression, scope);
      if (f.params[key] !== value) setFeatureDimension(f, key, value);
    }
}

/** Rename a variable inside an expression. */
export function renameInExpression(source: string, from: string, to: string) {
  return source.replace(new RegExp(`(?<![A-Za-z0-9_.])${from}(?![A-Za-z0-9_])`, "g"), to);
}

/** Where each variable is used, for refusing to delete one still in use. */
export function variableUses(doc: Document, name: string): string[] {
  const uses: string[] = [];
  const mentions = (src: string) => {
    try {
      return referencedNames(parseExpression(src)).has(name);
    } catch {
      return false;
    }
  };
  for (const v of doc.variables ?? []) if (v.name !== name && mentions(v.expression)) uses.push(`variable ${v.name}`);
  for (const sk of doc.sketches) for (const c of sk.constraints) if (c.expression && mentions(c.expression)) uses.push(`${sk.name} dimension`);
  for (const f of doc.features) for (const [key, src] of Object.entries(f.expressions ?? {})) if (mentions(src)) uses.push(`${f.name} ${key}`);
  return uses;
}
