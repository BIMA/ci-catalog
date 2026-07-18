import { parsePipeline } from "./parser.js";
import { buildGraph } from "./graph.js";
import { DagView } from "./render.js";
import { renderDrawer } from "./drawer.js";
import { fetchProject } from "./gitlab-api.js";
import { SAMPLE_YAML } from "./sample.js";
import { starterFiles, starterNames } from "./starters.js";
import { REF_CONTEXTS, filterModel, contextCounts } from "./refs.js";
import { deserializeModel } from "./serialize.js";

const $ = (sel) => document.querySelector(sel);

const state = {
  fullModel: null, // as parsed, all jobs
  model: null, // current ref-context view of fullModel
  graph: null,
  statuses: null, // Map<jobName, status> when connected to GitLab
  selected: null,
  sourceLabel: "",
  refContext: "all",
};

const view = new DagView($("#canvas"), { onSelect: selectJob });

function loadYaml(text, sourceLabel, parseOpts = {}) {
  let model;
  try {
    model = parsePipeline(text, parseOpts);
  } catch (e) {
    alert(`Could not parse pipeline:\n${e.message}`);
    return false;
  }
  applyModel(model, sourceLabel);
  return true;
}

// Load an already-built model (manifest entry or freshly parsed) into the view.
function applyModel(model, sourceLabel) {
  state.fullModel = model;
  state.selected = null;
  state.sourceLabel = sourceLabel;
  state.refContext = "all";
  if (sourceLabel !== state.connectedLabel) state.statuses = null;

  $("#empty-state").hidden = true;
  const hasExplicitNeeds = model.jobs.size > 0 && [...model.jobs.values()].some((j) => j.needs !== null);
  const implicitToggle = $("#implicit-toggle");
  implicitToggle.checked = !hasExplicitNeeds ? true : implicitToggle.checked;

  renderRefTabs();
  applyContext("all", { initial: true });
  renderWarnings();
  closeDrawer();
  $("#source-label").textContent = sourceLabel;
}

function applyContext(key, { initial = false } = {}) {
  state.refContext = key;
  const { model, verdicts, workflow } = filterModel(state.fullModel, key);
  state.model = model;
  state.graph = buildGraph(model);
  if (state.selected && !model.jobs.has(state.selected)) state.selected = null;

  view.setPipeline(model, state.graph, {
    showImplicit: $("#implicit-toggle").checked,
    verdicts,
    keepView: !initial,
  });
  if (state.statuses && initial) view.setStatuses(state.statuses);
  view.select(state.selected);
  if (!initial) view.fit();
  renderSidebar();

  const note = $("#workflow-note");
  const msgs = [];
  if (key !== "all" && model.jobs.size === 0) msgs.push("No jobs run for this ref.");
  if (key !== "all" && workflow === "F") {
    msgs.push("workflow: rules block this ref — GitLab would not create this pipeline at all.");
  } else if (key !== "all" && workflow === "U") {
    msgs.push("workflow: rules depend on project variables — this pipeline may not be created.");
  }
  note.hidden = msgs.length === 0;
  note.textContent = msgs.join(" ");

  document.querySelectorAll("#ref-tabs button").forEach((b) => {
    b.classList.toggle("active", b.dataset.ctx === key);
  });
}

function renderRefTabs() {
  const tabs = $("#ref-tabs");
  tabs.hidden = false;
  tabs.replaceChildren();
  const counts = contextCounts(state.fullModel);
  for (const [key, ctx] of Object.entries(REF_CONTEXTS)) {
    const btn = document.createElement("button");
    btn.dataset.ctx = key;
    btn.append(ctx.label, Object.assign(document.createElement("span"), { className: "tab-count", textContent: counts[key] }));
    btn.addEventListener("click", () => applyContext(key));
    tabs.appendChild(btn);
  }
}

function selectJob(name) {
  state.selected = name;
  view.select(name);
  document.querySelectorAll("#job-list .job-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.job === name);
  });
  if (!name) {
    closeDrawer();
    return;
  }
  const job = state.model.jobs.get(name);
  renderDrawer($("#drawer"), {
    job,
    model: state.model,
    graph: state.graph,
    status: state.statuses?.get(name) ?? null,
    onJump: (n) => selectJob(n),
    onClose: () => selectJob(null),
  });
}

function closeDrawer() {
  const drawer = $("#drawer");
  drawer.hidden = true;
  drawer.replaceChildren();
}

function renderSidebar() {
  const list = $("#job-list");
  list.replaceChildren();
  const filter = $("#search").value.trim().toLowerCase();
  let shown = 0;
  for (const stage of state.model.stages) {
    const jobs = [...state.model.jobs.values()].filter(
      (j) => j.stage === stage && (!filter || j.name.toLowerCase().includes(filter))
    );
    if (jobs.length === 0) continue;
    const group = document.createElement("div");
    group.className = "job-group";
    const head = document.createElement("div");
    head.className = "job-group-title";
    head.textContent = stage;
    group.appendChild(head);
    for (const job of jobs) {
      shown++;
      const item = document.createElement("button");
      item.className = "job-item";
      item.dataset.job = job.name;
      const status = state.statuses?.get(job.name);
      item.innerHTML = "";
      const dot = document.createElement("span");
      dot.className = status ? `list-dot status-${status.status}` : "list-dot";
      item.appendChild(dot);
      const label = document.createElement("span");
      label.className = "job-item-name";
      label.textContent = job.name;
      item.appendChild(label);
      if (job.manual) {
        const m = document.createElement("span");
        m.className = "job-item-flag";
        m.textContent = "manual";
        item.appendChild(m);
      }
      item.classList.toggle("active", state.selected === job.name);
      item.addEventListener("click", () => selectJob(job.name));
      group.appendChild(item);
    }
    list.appendChild(group);
  }
  $("#job-count").textContent = filter
    ? `${shown} / ${state.model.jobs.size}`
    : `${state.model.jobs.size}`;
}

function renderWarnings() {
  const box = $("#warnings");
  const items = state.model.warnings;
  box.hidden = items.length === 0;
  box.replaceChildren();
  if (items.length === 0) return;
  const title = document.createElement("div");
  title.className = "side-title";
  title.textContent = `Notes (${items.length})`;
  box.appendChild(title);
  for (const w of items) {
    const p = document.createElement("p");
    p.textContent = w;
    box.appendChild(p);
  }
}

// ---- wiring ----

$("#sample-btn").addEventListener("click", () => loadYaml(SAMPLE_YAML, "Sample pipeline"));
$("#empty-sample-btn").addEventListener("click", () => loadYaml(SAMPLE_YAML, "Sample pipeline"));

const starterSelect = $("#starter-select");
if (starterNames.length > 0) {
  $("#starter-field").hidden = false;
  for (const name of starterNames) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    starterSelect.appendChild(opt);
  }
  starterSelect.addEventListener("change", () => {
    const name = starterSelect.value;
    if (!name) return;
    loadYaml(starterFiles[name], `example/${name}`, { files: starterFiles, path: name });
  });
}

$("#paste-btn").addEventListener("click", () => {
  $("#paste-dialog").showModal();
  $("#paste-text").focus();
});
$("#paste-dialog").addEventListener("close", () => {
  if ($("#paste-dialog").returnValue === "ok") {
    const text = $("#paste-text").value;
    if (text.trim()) loadYaml(text, "Pasted YAML");
  }
});

$("#file-input").addEventListener("change", async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  loadYaml(await file.text(), file.name);
  ev.target.value = "";
});

$("#search").addEventListener("input", () => {
  if (state.model) renderSidebar();
});

$("#implicit-toggle").addEventListener("change", (ev) => {
  view.setShowImplicit(ev.target.checked);
});

$("#fit-btn").addEventListener("click", () => view.fit());
window.addEventListener("resize", () => view.fit());

$("#connect-btn").addEventListener("click", () => $("#connect-dialog").showModal());
$("#connect-dialog").addEventListener("close", async () => {
  if ($("#connect-dialog").returnValue !== "ok") return;
  const baseUrl = $("#gl-url").value;
  const projectPath = $("#gl-project").value;
  const ref = $("#gl-ref").value;
  const token = $("#gl-token").value || null;
  const btn = $("#connect-btn");
  btn.textContent = "Fetching…";
  btn.disabled = true;
  try {
    const { ciYaml, statuses, pipeline } = await fetchProject({ baseUrl, projectPath, ref, token });
    const label = `${projectPath} @ ${ref}${pipeline ? ` · pipeline #${pipeline.id} (${pipeline.status})` : ""}`;
    state.connectedLabel = label;
    if (loadYaml(ciYaml, label)) {
      state.statuses = statuses.size > 0 ? statuses : null;
      if (state.statuses) {
        view.setStatuses(state.statuses);
        renderSidebar();
      }
    }
  } catch (e) {
    alert(`GitLab fetch failed:\n${e.message}`);
  } finally {
    btn.textContent = "Connect GitLab…";
    btn.disabled = false;
  }
});

// ---- drawer resize (drag left edge) ----
{
  const DRAWER_W_KEY = "ci-catalog:drawer-width";
  const clampWidth = (w) => Math.min(Math.max(w, 300), Math.floor(window.innerWidth * 0.9));
  // Restore without clamping to innerWidth (0 when the tab loads in the
  // background); CSS max-width: 90vw caps oversized values.
  const saved = Number(localStorage.getItem(DRAWER_W_KEY));
  if (saved >= 300) {
    document.documentElement.style.setProperty("--drawer-w", `${saved}px`);
  }
  const resizer = $("#drawer-resizer");
  resizer.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    resizer.setPointerCapture(ev.pointerId);
    resizer.classList.add("dragging");
    document.body.classList.add("drawer-resizing");
    let width = null;
    const onMove = (mv) => {
      width = clampWidth(window.innerWidth - mv.clientX);
      document.documentElement.style.setProperty("--drawer-w", `${width}px`);
    };
    const onUp = () => {
      resizer.classList.remove("dragging");
      document.body.classList.remove("drawer-resizing");
      resizer.removeEventListener("pointermove", onMove);
      resizer.removeEventListener("pointerup", onUp);
      resizer.removeEventListener("pointercancel", onUp);
      if (width) localStorage.setItem(DRAWER_W_KEY, String(width));
    };
    resizer.addEventListener("pointermove", onMove);
    resizer.addEventListener("pointerup", onUp);
    resizer.addEventListener("pointercancel", onUp);
  });
}

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && state.selected) selectJob(null);
  if (ev.key === "/" && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") {
    ev.preventDefault();
    $("#search").focus();
  }
});

// ---- catalog (generated manifest) mode ----
// When a manifest.json sits next to index.html (produced by `docs:generate`),
// load it and drive the viewer from the pre-parsed models — no YAML parsing.

async function initCatalog() {
  let manifest;
  try {
    const res = await fetch("manifest.json", { cache: "no-store" });
    if (!res.ok) return false;
    manifest = await res.json();
  } catch {
    return false; // dev mode / no catalog — leave manual sources active
  }
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.pipelines)) return false;

  const section = $("#catalog-section");
  section.hidden = false;
  const when = new Date(manifest.generatedAt);
  $("#catalog-meta").textContent = `${manifest.project} · ${manifest.pipelines.length} pipelines · generated ${when.toLocaleString()}`;

  const select = $("#catalog-select");
  select.replaceChildren();
  const placeholder = new Option(`${manifest.project} — choose a pipeline…`, "");
  select.appendChild(placeholder);
  manifest.pipelines.forEach((p, i) => {
    const label = p.error ? `${p.name} — parse error` : `${p.name}  (${p.jobCount} jobs)`;
    const opt = new Option(label, String(i));
    if (p.error) opt.disabled = true;
    select.appendChild(opt);
  });

  select.addEventListener("change", () => {
    const entry = manifest.pipelines[Number(select.value)];
    if (!entry || entry.error) return;
    applyModel(deserializeModel(entry.model), `${manifest.project}/${entry.path}`);
  });

  // Auto-open the first successfully parsed pipeline.
  const firstOk = manifest.pipelines.findIndex((p) => !p.error);
  if (firstOk >= 0) {
    select.value = String(firstOk);
    applyModel(deserializeModel(manifest.pipelines[firstOk].model), `${manifest.project}/${manifest.pipelines[firstOk].path}`);
  }
  return true;
}

// In a production build with no catalog (e.g. the hosted demo), auto-load the
// sample so the DAG is visible on arrival. Dev keeps the empty state so you can
// paste your own config straight away.
initCatalog().then((loaded) => {
  if (!loaded && import.meta.env.PROD) loadYaml(SAMPLE_YAML, "Sample pipeline");
});
