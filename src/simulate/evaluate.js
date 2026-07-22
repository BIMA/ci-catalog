/**
 * The three-valued rule evaluator.
 *
 *   T  — definitely runs
 *   F  — definitely filtered out
 *   U  — depends on variables / changes / etc. we can't know ("maybe")
 *
 * Known variables hold a *set* of possible values (the default branch is
 * modeled as {main, master} since templates target both); comparisons use
 * union semantics — the job is shown if any possible value would run it.
 */

import { UNKNOWN, known } from "./scenarios.js";

// ---- three-valued logic ----

export const and3 = (a, b) => (a === "F" || b === "F" ? "F" : a === "U" || b === "U" ? "U" : "T");
export const or3 = (a, b) => (a === "T" || b === "T" ? "T" : a === "U" || b === "U" ? "U" : "F");
export const not3 = (a) => (a === "T" ? "F" : a === "F" ? "T" : "U");

// ---- `rules: if:` expression tokenizer ----

export function tokenize(src) {
  const tokens = [];
  let i = 0;
  const push = (type, value) => tokens.push({ type, value });
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (src.startsWith("&&", i)) { push("and"); i += 2; continue; }
    if (src.startsWith("||", i)) { push("or"); i += 2; continue; }
    if (src.startsWith("==", i)) { push("op", "=="); i += 2; continue; }
    if (src.startsWith("!=", i)) { push("op", "!="); i += 2; continue; }
    if (src.startsWith("=~", i)) { push("op", "=~"); i += 2; continue; }
    if (src.startsWith("!~", i)) { push("op", "!~"); i += 2; continue; }
    if (c === "(") { push("lparen"); i++; continue; }
    if (c === ")") { push("rparen"); i++; continue; }
    if (c === "$") {
      const m = /^\$\{?(\w+)\}?/.exec(src.slice(i));
      push("var", m[1]);
      i += m[0].length;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1);
      if (end === -1) throw new Error("unterminated string");
      push("str", src.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    if (c === "/") {
      // regex literal: /.../flags — find unescaped closing slash
      let j = i + 1;
      while (j < src.length && (src[j] !== "/" || src[j - 1] === "\\")) j++;
      if (j >= src.length) throw new Error("unterminated regex");
      let k = j + 1;
      while (k < src.length && /[a-z]/i.test(src[k])) k++;
      push("regex", { source: src.slice(i + 1, j), flags: src.slice(j + 1, k) });
      i = k;
      continue;
    }
    if (src.startsWith("null", i)) { push("null"); i += 4; continue; }
    throw new Error(`unexpected character \`${c}\``);
  }
  return tokens;
}

/**
 * Evaluate a GitLab `rules: if:` expression → 'T' | 'F' | 'U'.
 * Unknown variables (project/instance CI variables) make comparisons 'U'.
 */
export function evalIf(expr, vars) {
  let tokens;
  try {
    tokens = tokenize(String(expr));
  } catch {
    return "U";
  }
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  // operand → {known, vals} | regex token
  const operand = () => {
    const t = next();
    if (!t) throw new Error("eof");
    if (t.type === "var") return vars[t.value] ?? UNKNOWN;
    if (t.type === "str") return known(t.value);
    if (t.type === "null") return known(null);
    if (t.type === "regex") return { regex: t.value };
    throw new Error("bad operand");
  };

  const truthy = (v) => {
    if (!v.known) return "U";
    const results = v.vals.map((x) => x !== null && x !== "");
    return results.every(Boolean) ? "T" : results.some(Boolean) ? "T" : "F";
  };

  const compare = (a, op, b) => {
    if (op === "=~" || op === "!~") {
      const rx = b.regex ?? (b.known && b.vals[0] !== null ? { source: String(b.vals[0]), flags: "" } : null);
      if (!rx || !a.known) return "U";
      let re;
      try {
        re = new RegExp(rx.source, rx.flags);
      } catch {
        return "U";
      }
      const hit = a.vals.some((x) => x !== null && re.test(String(x)));
      const res = hit ? "T" : "F";
      return op === "=~" ? res : not3(res);
    }
    if (!a.known || !b.known) return "U";
    // union semantics: T if any possible pair matches
    const hit = a.vals.some((x) => b.vals.some((y) => x === y));
    const miss = a.vals.some((x) => b.vals.some((y) => x !== y)) || a.vals.length === 0;
    const eq = hit ? "T" : "F";
    if (op === "==") return eq;
    // "!=": with multi-valued sets both == and != can hold; prefer showing the job
    return hit && !miss ? "F" : hit ? "T" : "T";
  };

  const comparison = () => {
    if (peek()?.type === "lparen") {
      next();
      const v = orExpr();
      if (peek()?.type === "rparen") next();
      return v;
    }
    const left = operand();
    if (peek()?.type === "op") {
      const op = next().value;
      const right = operand();
      return compare(left, op, right);
    }
    return truthy(left);
  };

  const andExpr = () => {
    let v = comparison();
    while (peek()?.type === "and") {
      next();
      v = and3(v, comparison());
    }
    return v;
  };
  const orExpr = () => {
    let v = andExpr();
    while (peek()?.type === "or") {
      next();
      v = or3(v, andExpr());
    }
    return v;
  };

  try {
    const result = orExpr();
    return pos === tokens.length ? result : "U";
  } catch {
    return "U";
  }
}

// ---- rules / only / except → verdict ----

export function evalRulesList(rules, ctx) {
  if (!Array.isArray(rules)) return "U";
  let sawUnknown = false;
  for (const rule of rules) {
    const r = typeof rule === "string" ? { if: rule } : rule ?? {};
    let cond = r.if !== undefined ? evalIf(r.if, ctx.vars) : "T";
    if (r.changes !== undefined || r.exists !== undefined) cond = and3(cond, "U");
    if (cond === "T") {
      const outcome = r.when === "never" ? "F" : "T";
      return sawUnknown ? "U" : outcome;
    }
    if (cond === "U") sawUnknown = true;
  }
  return sawUnknown ? "U" : "F";
}

function matchRefKeyword(entry, ctx) {
  const s = String(entry);
  const rxMatch = /^\/(.*)\/([a-z]*)$/.exec(s);
  if (rxMatch) {
    try {
      const re = new RegExp(rxMatch[1], rxMatch[2]);
      return ctx.refNames.some((n) => re.test(n)) ? "T" : "F";
    } catch {
      return "U";
    }
  }
  switch (s) {
    case "merge_requests": return ctx.kind === "mr" ? "T" : "F";
    case "branches": return ctx.kind === "branch" || ctx.kind === "schedule" ? "T" : "F";
    case "tags": return ctx.kind === "tag" ? "T" : "F";
    case "schedules": return ctx.kind === "schedule" ? "T" : "F";
    case "pushes": return ctx.kind === "branch" || ctx.kind === "tag" ? "T" : "F";
    case "web":
    case "api":
    case "triggers":
    case "pipelines":
    case "external_pull_requests":
    case "external": return "F";
    default:
      // branch/tag name, possibly with wildcards
      if (s.includes("*")) {
        try {
          const re = new RegExp("^" + s.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
          return ctx.refNames.some((n) => re.test(n)) ? "T" : "F";
        } catch {
          return "U";
        }
      }
      return ctx.refNames.includes(s) ? "T" : "F";
  }
}

function evalOnlyClause(clause, ctx) {
  // returns verdict that the clause MATCHES
  if (clause === null || clause === undefined) return null;
  const obj = Array.isArray(clause) ? { refs: clause } : clause;
  let v = "T";
  if (Array.isArray(obj.refs)) {
    v = and3(v, obj.refs.map((e) => matchRefKeyword(e, ctx)).reduce(or3, "F"));
  }
  if (Array.isArray(obj.variables)) {
    v = and3(v, obj.variables.map((e) => evalIf(e, ctx.vars)).reduce(or3, "F"));
  }
  if (obj.changes !== undefined) v = and3(v, "U");
  if (obj.kubernetes !== undefined) v = and3(v, "U");
  return v;
}

/** Verdict for one job under one scenario: 'T' | 'F' | 'U'. */
export function jobVerdict(job, ctx) {
  if (Array.isArray(job.rules)) return evalRulesList(job.rules, ctx);
  const only = evalOnlyClause(job.only, ctx);
  const except = evalOnlyClause(job.except, ctx);
  let v = only ?? "T";
  if (except !== null) v = and3(v, not3(except));
  return v;
}
