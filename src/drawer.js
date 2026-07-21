import { dumpJobYaml } from "./resolve/index.js";
import { lineageOf } from "./graph.js";
import { formatCondition } from "./refs.js";

function h(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function section(title) {
  const wrap = h("section", "drawer-section");
  wrap.appendChild(h("div", "drawer-section-title", title));
  return wrap;
}

function kvRow(parent, key, value, { mono = true } = {}) {
  if (value === null || value === undefined || value === "") return;
  const row = h("div", "kv");
  row.appendChild(h("dt", null, key));
  const dd = h("dd", mono ? "mono" : null);
  dd.textContent = String(value);
  row.appendChild(dd);
  parent.appendChild(row);
}

function scriptBlock(parent, label, lines) {
  if (!lines) return;
  // GitLab flattens nested script arrays (anchors/!reference produce them).
  const arr = (Array.isArray(lines) ? lines : [lines]).flat(Infinity);
  if (arr.length === 0) return;
  parent.appendChild(h("div", "script-label", label));
  const pre = h("pre", "script");
  pre.textContent = arr.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n");
  parent.appendChild(pre);
}

function jobLinkList(names, onJump, emptyText) {
  const wrap = h("div", "job-links");
  if (names.length === 0) {
    wrap.appendChild(h("span", "muted", emptyText));
    return wrap;
  }
  for (const n of names) {
    const btn = h("button", "job-link mono", n);
    btn.addEventListener("click", () => onJump(n));
    wrap.appendChild(btn);
  }
  return wrap;
}

function chipRow(parent, label, items) {
  if (!items || items.length === 0) return;
  const row = h("div", "cond-row");
  row.appendChild(h("span", "cond-label", label));
  const wrap = h("div", "chip-wrap");
  for (const it of items) wrap.appendChild(h("code", "cond-chip", typeof it === "string" ? it : JSON.stringify(it)));
  row.appendChild(wrap);
  parent.appendChild(row);
}

function condExpr(parent, label, expr) {
  if (expr === undefined || expr === null) return;
  const row = h("div", "cond-row");
  row.appendChild(h("span", "cond-label", label));
  const code = h("code", "cond-expr");
  code.textContent = formatCondition(expr);
  row.appendChild(code);
  parent.appendChild(row);
}

const WHEN_CLASS = {
  never: "when-never",
  manual: "when-manual",
  delayed: "when-delayed",
  always: "when-always",
  on_failure: "when-never",
};

function whenBadge(when, startIn) {
  const w = when ?? "on_success";
  const badge = h("span", `when-badge ${WHEN_CLASS[w] ?? ""}`, w === "delayed" && startIn ? `delayed ${startIn}` : w);
  return badge;
}

function ruleCard(rule, idx) {
  const r = typeof rule === "string" ? { if: rule } : rule ?? {};
  const card = h("div", "rule-card");
  const head = h("div", "rule-head");
  head.appendChild(h("span", "rule-idx", String(idx + 1).padStart(2, "0")));
  head.appendChild(whenBadge(r.when, r.start_in));
  if (r.allow_failure === true) head.appendChild(h("span", "when-badge", "may fail"));
  card.appendChild(head);
  condExpr(card, "if", r.if);
  chipRow(card, "changes", Array.isArray(r.changes) ? r.changes : r.changes?.paths);
  chipRow(card, "exists", Array.isArray(r.exists) ? r.exists : r.exists ? [r.exists] : null);
  if (isPlainObject(r.variables)) {
    const dl = h("dl", "kv-list rule-vars");
    for (const [k, v] of Object.entries(r.variables)) kvRow(dl, k, String(v));
    card.appendChild(dl);
  }
  if (!r.if && !r.changes && !r.exists) {
    card.appendChild(h("p", "muted small", "No condition — always matches (catch-all)."));
  }
  return card;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function onlyExceptBlock(parent, title, clause, hint) {
  if (clause === null || clause === undefined) return;
  const obj = Array.isArray(clause) ? { refs: clause } : clause;
  const card = h("div", "rule-card");
  const head = h("div", "rule-head");
  head.appendChild(h("span", "rule-idx", title));
  head.appendChild(h("span", "muted small-inline", hint));
  card.appendChild(head);
  chipRow(card, "refs", obj.refs);
  if (Array.isArray(obj.variables)) {
    const row = h("div", "cond-row");
    row.appendChild(h("span", "cond-label", "variables"));
    const list = h("div", "cond-expr-list");
    for (const v of obj.variables) {
      const code = h("code", "cond-expr");
      code.textContent = formatCondition(v);
      list.appendChild(code);
    }
    row.appendChild(list);
    card.appendChild(row);
  }
  chipRow(card, "changes", Array.isArray(obj.changes) ? obj.changes : obj.changes?.paths);
  if (obj.kubernetes !== undefined) condExpr(card, "kubernetes", JSON.stringify(obj.kubernetes));
  parent.appendChild(card);
}

const STATUS_TEXT = {
  success: "Passed",
  failed: "Failed",
  running: "Running",
  pending: "Pending",
  created: "Created",
  manual: "Manual — waiting for action",
  skipped: "Skipped",
  canceled: "Canceled",
};

/** Render job detail into the drawer element. */
export function renderDrawer(drawer, { job, model, graph, status, onJump, onClose }) {
  drawer.replaceChildren();
  drawer.hidden = false;

  const head = h("header", "drawer-head");
  const eyebrow = h("div", "drawer-eyebrow");
  eyebrow.appendChild(h("span", "stage-chip mono", job.stage));
  if (status) {
    eyebrow.appendChild(h("span", `status-chip status-${status.status}`, STATUS_TEXT[status.status] ?? status.status));
  }
  head.appendChild(eyebrow);
  const titleRow = h("div", "drawer-title-row");
  titleRow.appendChild(h("h2", "drawer-title mono", job.name));
  const close = h("button", "drawer-close", "×");
  close.setAttribute("aria-label", "Close details");
  close.addEventListener("click", onClose);
  titleRow.appendChild(close);
  head.appendChild(titleRow);
  drawer.appendChild(head);

  // Overview
  const overview = section("Overview");
  const dl = h("dl", "kv-list");
  kvRow(dl, "when", job.when ?? (job.rules ? "governed by rules" : null), { mono: true });
  kvRow(dl, "allow_failure", job.allowFailure ? "true" : null);
  kvRow(dl, "parallel", job.parallel ? `${job.parallel.count} (${job.parallel.kind})` : null);
  kvRow(dl, "environment", typeof job.environment === "string" ? job.environment : job.environment?.name);
  kvRow(dl, "resource_group", job.resourceGroup);
  kvRow(dl, "timeout", job.timeout);
  kvRow(dl, "retry", job.retry ? JSON.stringify(job.retry) : null);
  kvRow(dl, "coverage", job.coverage);
  if (job.trigger) {
    kvRow(dl, "trigger", typeof job.trigger === "string" ? job.trigger : job.trigger.include ? "child pipeline" : job.trigger.project ?? "downstream");
  }
  if (status) {
    kvRow(dl, "duration", status.duration ? `${Math.round(status.duration)}s` : null);
    kvRow(dl, "runner", status.runner ?? null);
  }
  overview.appendChild(dl);
  drawer.appendChild(overview);

  // Lineage
  const lin = lineageOf(job.name, graph);
  const upDirect = [...(graph.upstream.get(job.name) ?? [])];
  const downDirect = [...(graph.downstream.get(job.name) ?? [])];
  const lineage = section("Lineage");
  const transitiveDetails = (label, all, direct) => {
    const rest = [...all].filter((n) => !direct.includes(n)).sort();
    if (rest.length === 0) return null;
    const det = h("details", "lineage-details");
    det.appendChild(h("summary", null, `${label} (${rest.length} more)`));
    det.appendChild(jobLinkList(rest, onJump, ""));
    return det;
  };
  lineage.appendChild(h("div", "script-label", `Upstream — direct ${upDirect.length}, total ${lin.up.size}`));
  lineage.appendChild(jobLinkList(upDirect.sort(), onJump, job.startsImmediately ? "needs: [] — starts immediately" : "none — pipeline entry point"));
  const upMore = transitiveDetails("all transitive upstream", lin.up, upDirect);
  if (upMore) lineage.appendChild(upMore);
  lineage.appendChild(h("div", "script-label", `Downstream — direct ${downDirect.length}, total ${lin.down.size}`));
  lineage.appendChild(jobLinkList(downDirect.sort(), onJump, "none — nothing waits on this job"));
  const downMore = transitiveDetails("all transitive downstream", lin.down, downDirect);
  if (downMore) lineage.appendChild(downMore);
  if (job.needs === null) {
    lineage.appendChild(h("p", "muted small", "No explicit needs — waits for the previous stage to finish (stage ordering)."));
  }
  if (job.needs?.some((n) => n.external)) {
    lineage.appendChild(h("p", "muted small", "Has cross-pipeline/project needs (not drawn)."));
  }
  drawer.appendChild(lineage);

  // Execution
  if (job.image || job.tags || job.services) {
    const exec = section("Execution");
    const dl2 = h("dl", "kv-list");
    kvRow(dl2, "image", job.image);
    kvRow(dl2, "tags", Array.isArray(job.tags) ? job.tags.join(", ") : job.tags);
    kvRow(
      dl2,
      "services",
      Array.isArray(job.services)
        ? job.services.map((s) => (typeof s === "string" ? s : s.name)).join(", ")
        : null
    );
    exec.appendChild(dl2);
    drawer.appendChild(exec);
  }

  // Scripts
  if (job.beforeScript || job.script || job.afterScript) {
    const scripts = section("Scripts");
    scriptBlock(scripts, "before_script", job.beforeScript);
    scriptBlock(scripts, "script", job.script);
    scriptBlock(scripts, "after_script", job.afterScript);
    drawer.appendChild(scripts);
  }

  // Conditions
  if (job.rules || job.only || job.except) {
    const cond = section("Run conditions");
    if (Array.isArray(job.rules)) {
      cond.appendChild(h("p", "muted small rule-hint", `${job.rules.length} rule${job.rules.length > 1 ? "s" : ""} — first match decides.`));
      job.rules.forEach((rule, i) => cond.appendChild(ruleCard(rule, i)));
    }
    onlyExceptBlock(cond, "only", job.only, "job runs only when this matches");
    onlyExceptBlock(cond, "except", job.except, "job is skipped when this matches");
    drawer.appendChild(cond);
  }

  // Artifacts & cache
  if (job.artifacts || job.cache || job.dependencies) {
    const art = section("Artifacts & cache");
    if (job.artifacts?.paths) scriptBlock(art, "artifact paths", job.artifacts.paths);
    if (job.artifacts?.reports) scriptBlock(art, "reports", Object.keys(job.artifacts.reports).map((k) => k));
    const dl3 = h("dl", "kv-list");
    kvRow(dl3, "expire_in", job.artifacts?.expire_in);
    kvRow(dl3, "cache key", typeof job.cache?.key === "string" ? job.cache.key : job.cache?.key ? JSON.stringify(job.cache.key) : null);
    if (job.dependencies) kvRow(dl3, "dependencies", job.dependencies.join(", ") || "[] (none)");
    art.appendChild(dl3);
    drawer.appendChild(art);
  }

  // Variables
  if (job.variables && Object.keys(job.variables).length) {
    const vars = section("Variables");
    const dl4 = h("dl", "kv-list");
    for (const [k, v] of Object.entries(job.variables)) {
      kvRow(dl4, k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    vars.appendChild(dl4);
    drawer.appendChild(vars);
  }

  // Raw definition
  const raw = section("Resolved definition");
  raw.appendChild(h("p", "muted small", "After extends/defaults resolution — what GitLab actually runs."));
  const pre = h("pre", "script raw-yaml");
  pre.textContent = dumpJobYaml(job);
  raw.appendChild(pre);
  drawer.appendChild(raw);

  if (status?.web_url) {
    const foot = section("GitLab");
    const a = h("a", "job-link", "Open job in GitLab ↗");
    a.href = status.web_url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    foot.appendChild(a);
    drawer.appendChild(foot);
  }
}
