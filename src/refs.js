/**
 * Per-ref pipeline simulation.
 *
 * Each context ("what kind of ref triggered the pipeline") defines the
 * predefined CI variables it implies. Job `rules` / `only` / `except` and
 * `workflow:` are evaluated against them with three-valued logic:
 *   T  — definitely runs
 *   F  — definitely filtered out
 *   U  — depends on project variables / changes / etc. we can't know ("maybe")
 *
 * Known variables hold a *set* of possible values (the default branch is
 * modeled as {main, master} since templates target both); comparisons use
 * union semantics — the job is shown if any possible value would run it.
 */

const DEFAULT_BRANCHES = ["main", "master"];

function known(...vals) {
  return { known: true, vals };
}
const UNKNOWN = { known: false };

export const REF_CONTEXTS = {
  all: { label: "All jobs" },
  mr: {
    label: "Merge request",
    kind: "mr",
    refNames: ["feature/awesome"],
    vars: {
      CI_PIPELINE_SOURCE: known("merge_request_event"),
      CI_COMMIT_BRANCH: known(null),
      CI_COMMIT_TAG: known(null),
      CI_COMMIT_REF_NAME: known("feature/awesome"),
      CI_MERGE_REQUEST_ID: known("1"),
      CI_MERGE_REQUEST_IID: known("1"),
      CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: known("feature/awesome"),
      CI_MERGE_REQUEST_TARGET_BRANCH_NAME: known(...DEFAULT_BRANCHES),
      CI_OPEN_MERGE_REQUESTS: known("group/project!1"),
      CI_DEFAULT_BRANCH: known(...DEFAULT_BRANCHES),
    },
  },
  default: {
    label: "Default branch",
    kind: "branch",
    refNames: DEFAULT_BRANCHES,
    vars: {
      CI_PIPELINE_SOURCE: known("push"),
      CI_COMMIT_BRANCH: known(...DEFAULT_BRANCHES),
      CI_COMMIT_TAG: known(null),
      CI_COMMIT_REF_NAME: known(...DEFAULT_BRANCHES),
      CI_MERGE_REQUEST_ID: known(null),
      CI_OPEN_MERGE_REQUESTS: known(null),
      CI_DEFAULT_BRANCH: known(...DEFAULT_BRANCHES),
    },
  },
  branch: {
    label: "Feature branch",
    kind: "branch",
    refNames: ["feature/awesome"],
    vars: {
      CI_PIPELINE_SOURCE: known("push"),
      CI_COMMIT_BRANCH: known("feature/awesome"),
      CI_COMMIT_TAG: known(null),
      CI_COMMIT_REF_NAME: known("feature/awesome"),
      CI_MERGE_REQUEST_ID: known(null),
      CI_OPEN_MERGE_REQUESTS: known(null),
      CI_DEFAULT_BRANCH: known(...DEFAULT_BRANCHES),
    },
  },
  tag: {
    label: "Tag",
    kind: "tag",
    refNames: ["v1.0.0"],
    vars: {
      CI_PIPELINE_SOURCE: known("push"),
      CI_COMMIT_BRANCH: known(null),
      CI_COMMIT_TAG: known("v1.0.0"),
      CI_COMMIT_REF_NAME: known("v1.0.0"),
      CI_MERGE_REQUEST_ID: known(null),
      CI_OPEN_MERGE_REQUESTS: known(null),
      CI_DEFAULT_BRANCH: known(...DEFAULT_BRANCHES),
    },
  },
  schedule: {
    label: "Schedule",
    kind: "schedule",
    refNames: DEFAULT_BRANCHES,
    vars: {
      CI_PIPELINE_SOURCE: known("schedule"),
      CI_COMMIT_BRANCH: known(...DEFAULT_BRANCHES),
      CI_COMMIT_TAG: known(null),
      CI_COMMIT_REF_NAME: known(...DEFAULT_BRANCHES),
      CI_MERGE_REQUEST_ID: known(null),
      CI_OPEN_MERGE_REQUESTS: known(null),
      CI_DEFAULT_BRANCH: known(...DEFAULT_BRANCHES),
    },
  },
};

// ---- three-valued logic ----

const and3 = (a, b) => (a === "F" || b === "F" ? "F" : a === "U" || b === "U" ? "U" : "T");
const or3 = (a, b) => (a === "T" || b === "T" ? "T" : a === "U" || b === "U" ? "U" : "F");
const not3 = (a) => (a === "T" ? "F" : a === "F" ? "T" : "U");

// ---- `rules: if:` expression evaluator ----

function tokenize(src) {
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
 * Pretty-print a `rules: if:` expression: one comparison per line, `&&`/`||`
 * trailing, parenthesized groups indented. Falls back to the original
 * (whitespace-collapsed) when the expression doesn't tokenize.
 */
export function formatCondition(expr) {
  let tokens;
  try {
    tokens = tokenize(String(expr));
  } catch {
    return String(expr).replace(/\s+/g, " ").trim();
  }
  const tokText = (t) => {
    switch (t.type) {
      case "var": return "$" + t.value;
      case "str": return `'${t.value}'`;
      case "regex": return `/${t.value.source}/${t.value.flags}`;
      case "null": return "null";
      case "op": return t.value;
      case "and": return "&&";
      case "or": return "||";
      default: return "";
    }
  };
  const lines = [];
  let indent = 0;
  let cur = "";
  const flush = () => {
    if (cur.trim()) lines.push("  ".repeat(indent) + cur.trim());
    cur = "";
  };
  for (const t of tokens) {
    if (t.type === "lparen") {
      flush();
      lines.push("  ".repeat(indent) + "(");
      indent++;
    } else if (t.type === "rparen") {
      flush();
      indent = Math.max(0, indent - 1);
      cur = ")";
    } else if (t.type === "and" || t.type === "or") {
      cur += (cur ? " " : "") + tokText(t);
      flush();
    } else {
      cur += (cur ? " " : "") + tokText(t);
    }
  }
  flush();
  return lines.join("\n");
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

function evalRulesList(rules, ctx) {
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

/** Verdict for one job in a context: 'T' | 'F' | 'U'. */
export function jobVerdict(job, ctx) {
  if (Array.isArray(job.rules)) return evalRulesList(job.rules, ctx);
  const only = evalOnlyClause(job.only, ctx);
  const except = evalOnlyClause(job.except, ctx);
  let v = only ?? "T";
  if (except !== null) v = and3(v, not3(except));
  return v;
}

/**
 * Filter a parsed pipeline model down to one ref context.
 * Returns { model, verdicts: Map<name,'T'|'U'>, workflow: 'T'|'F'|'U' }.
 */
export function filterModel(model, ctxKey) {
  const ctx = REF_CONTEXTS[ctxKey];
  if (!ctx || ctxKey === "all") {
    return { model, verdicts: new Map(), workflow: "T" };
  }
  const verdicts = new Map();
  const jobs = new Map();
  for (const [name, job] of model.jobs) {
    const v = jobVerdict(job, ctx);
    if (v === "F") continue;
    verdicts.set(name, v);
    jobs.set(name, job);
  }
  const stages = model.stages.filter((s) => [...jobs.values()].some((j) => j.stage === s));
  const workflow = Array.isArray(model.workflow?.rules)
    ? evalRulesList(model.workflow.rules, ctx)
    : "T";
  return {
    model: { ...model, stages, jobs, warnings: [] },
    verdicts,
    workflow,
  };
}

/** Per-context job counts for tab labels. */
export function contextCounts(model) {
  const counts = {};
  for (const key of Object.keys(REF_CONTEXTS)) {
    counts[key] = key === "all" ? model.jobs.size : filterModel(model, key).model.jobs.size;
  }
  return counts;
}
