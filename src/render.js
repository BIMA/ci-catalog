import { NODE_W, NODE_H, layoutPipeline, wirePath } from "./layout.js";
import { lineageOf } from "./graph.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const PAD = 60;

function el(tag, attrs = {}, parent = null) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  if (parent) parent.appendChild(node);
  return node;
}

const STATUS_LABELS = {
  success: "passed",
  failed: "failed",
  running: "running",
  pending: "pending",
  created: "created",
  manual: "manual",
  skipped: "skipped",
  canceled: "canceled",
  waiting_for_resource: "waiting",
  scheduled: "scheduled",
};

export class DagView {
  constructor(svg, { onSelect }) {
    this.svg = svg;
    this.onSelect = onSelect;
    this.viewport = el("g", { class: "viewport" }, svg);
    this.state = null;
    this.transform = { x: PAD, y: PAD, k: 1 };
    this.#bindPanZoom();
    // Click on empty canvas clears the selection (unless it ends a pan).
    this.svg.addEventListener("click", () => {
      if (!this.panned) this.onSelect(null);
    });
  }

  setPipeline(model, graph, { showImplicit, verdicts = null, keepView = false }) {
    const prevSelected = this.state?.selected ?? null;
    const prevStatuses = this.state?.statuses ?? null;
    this.state = {
      model,
      graph,
      showImplicit,
      verdicts,
      selected: keepView && prevSelected && model.jobs.has(prevSelected) ? prevSelected : null,
      statuses: keepView ? prevStatuses : null,
    };
    this.#draw();
    if (keepView) this.#applyFocus();
    else this.fit();
  }

  setShowImplicit(showImplicit) {
    if (!this.state) return;
    this.state.showImplicit = showImplicit;
    this.#draw();
    this.#applyFocus();
  }

  setStatuses(statuses) {
    if (!this.state) return;
    this.state.statuses = statuses;
    this.#draw();
    this.#applyFocus();
  }

  select(name) {
    if (!this.state) return;
    this.state.selected = name;
    this.#applyFocus();
  }

  hasNode(name) {
    return Boolean(this.state?.model.jobs.has(name));
  }

  #visibleEdges() {
    const { graph, showImplicit } = this.state;
    return graph.edges.filter((e) => e.kind === "needs" || showImplicit);
  }

  #draw() {
    const { model, graph } = this.state;
    this.layout = layoutPipeline(model, graph);
    const { positions, lanes, width, height } = this.layout;
    this.viewport.replaceChildren();

    const laneLayer = el("g", {}, this.viewport);
    for (const lane of lanes) {
      const g = el("g", { class: "lane" }, laneLayer);
      el("rect", { x: lane.x, y: 0, width: lane.w, height: lane.h, rx: 10, class: "lane-bg" }, g);
      el("line", { x1: lane.x + 14, y1: 44, x2: lane.x + lane.w - 14, y2: 44, class: "lane-rule" }, g);
      const label = el("text", { x: lane.x + 16, y: 28, class: "lane-name" }, g);
      label.textContent = lane.stage.toUpperCase();
      const count = el("text", { x: lane.x + lane.w - 16, y: 28, class: "lane-count", "text-anchor": "end" }, g);
      count.textContent = String(lane.count).padStart(2, "0");
    }

    // Edge slot assignment: spread vertical wire runs entering the same lane
    // column so they don't overlap (nodes in one lane share the same x).
    const edges = this.#visibleEdges();
    const byTargetCol = new Map();
    for (const e of edges) {
      const key = positions.get(e.to).x;
      if (!byTargetCol.has(key)) byTargetCol.set(key, []);
      byTargetCol.get(key).push(e);
    }

    this.edgeLayer = el("g", {}, this.viewport);
    this.edgeEls = new Map();
    for (const [, group] of byTargetCol) {
      group.forEach((e, i) => {
        const d = wirePath(positions.get(e.from), positions.get(e.to), i, group.length);
        const cls = ["edge", e.kind === "stage" ? "edge-stage" : "edge-needs", e.optional ? "edge-optional" : ""]
          .filter(Boolean)
          .join(" ");
        const hit = el("path", { d, class: "edge-hit" }, this.edgeLayer);
        const path = el("path", { d, class: cls }, this.edgeLayer);
        el("circle", { cx: positions.get(e.to).x, cy: positions.get(e.to).y + NODE_H / 2, r: 3.2, class: "edge-pin" }, this.edgeLayer);
        this.edgeEls.set(e, path);
        hit.addEventListener("mouseenter", () => path.classList.add("edge-hover"));
        hit.addEventListener("mouseleave", () => path.classList.remove("edge-hover"));
      });
    }

    this.nodeLayer = el("g", {}, this.viewport);
    this.nodeEls = new Map();
    for (const job of model.jobs.values()) {
      const pos = positions.get(job.name);
      const verdict = this.state.verdicts?.get(job.name);
      const g = el(
        "g",
        { class: `node${verdict === "U" ? " node-maybe" : ""}`, transform: `translate(${pos.x}, ${pos.y})`, tabindex: 0, role: "button" },
        this.nodeLayer
      );
      el("rect", { width: NODE_W, height: NODE_H, rx: 7, class: "node-box" }, g);

      const status = this.state.statuses?.get(job.name);
      if (status) {
        el("circle", { cx: 16, cy: NODE_H / 2, r: 5, class: `status-dot status-${status.status}` }, g);
      } else {
        el("rect", { x: 11, y: NODE_H / 2 - 5, width: 10, height: 10, rx: 2.5, class: "node-glyph" }, g);
      }

      const name = el("text", { x: 32, y: 24, class: "node-name" }, g);
      const nameTruncated = job.name.length > 22;
      name.textContent = nameTruncated ? job.name.slice(0, 21) + "…" : job.name;

      const badges = [];
      if (verdict === "U") badges.push("conditional");
      if (status) badges.push(STATUS_LABELS[status.status] ?? status.status);
      if (job.manual && !status) badges.push("manual");
      if (job.startsImmediately) badges.push("needs: []");
      if (job.parallel) badges.push(`×${job.parallel.count}`);
      if (job.trigger) badges.push("trigger ↗");
      if (job.allowFailure) badges.push("may fail");
      const subFull = badges.join(" · ");
      // ~26 chars of 10px mono fit between x=32 and the box's right padding
      const SUB_MAX = 26;
      const subTruncated = subFull.length > SUB_MAX;
      const sub = el("text", { x: 32, y: 42, class: `node-sub ${status ? "node-sub-" + status.status : ""}` }, g);
      sub.textContent = subTruncated ? subFull.slice(0, SUB_MAX - 1).trimEnd() + "…" : subFull;

      if (nameTruncated || subTruncated) {
        el("title", {}, g).textContent = subFull ? `${job.name}\n${subFull}` : job.name;
      }

      g.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.onSelect(job.name);
      });
      g.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          this.onSelect(job.name);
        }
      });
      this.nodeEls.set(job.name, g);
    }

    this.width = width;
    this.height = height;
  }

  #applyFocus() {
    const { graph, selected } = this.state;
    const legend = document.getElementById("lineage-legend");
    if (!selected || !this.nodeEls.has(selected)) {
      for (const g of this.nodeEls.values()) g.classList.remove("dim", "focus", "focus-up", "focus-down");
      for (const p of this.edgeEls.values()) p.classList.remove("dim", "lit-up", "lit-down");
      if (legend) legend.hidden = true;
      return;
    }
    if (legend) legend.hidden = false;
    const { up, down } = lineageOf(selected, graph);
    const related = new Set([selected, ...up, ...down]);
    for (const [name, g] of this.nodeEls) {
      g.classList.toggle("dim", !related.has(name));
      g.classList.toggle("focus", name === selected);
      g.classList.toggle("focus-up", up.has(name));
      g.classList.toggle("focus-down", down.has(name));
    }
    for (const [e, p] of this.edgeEls) {
      const upSide = (n) => up.has(n) || n === selected;
      const downSide = (n) => down.has(n) || n === selected;
      const litUp = upSide(e.from) && upSide(e.to);
      const litDown = !litUp && downSide(e.from) && downSide(e.to);
      p.classList.toggle("lit-up", litUp);
      p.classList.toggle("lit-down", litDown);
      p.classList.toggle("dim", !litUp && !litDown);
    }
  }

  fit() {
    const wrap = this.svg.getBoundingClientRect();
    if (!this.width || wrap.width === 0) return;
    const ideal = Math.min(
      (wrap.width - PAD * 2) / this.width,
      (wrap.height - PAD * 2) / this.height,
      1.15
    );
    // Never fit below readable scale — left-align and let the user pan.
    const k = Math.max(ideal, 0.55);
    this.transform = {
      k,
      x: ideal < 0.55 ? PAD / 2 : (wrap.width - this.width * k) / 2,
      y: (wrap.height - this.height * k) / 2,
    };
    this.#applyTransform();
  }

  #applyTransform() {
    const { x, y, k } = this.transform;
    this.viewport.setAttribute("transform", `translate(${x}, ${y}) scale(${k})`);
  }

  #bindPanZoom() {
    let dragging = null;
    this.svg.addEventListener("pointerdown", (ev) => {
      if (ev.target.closest(".node")) return;
      this.panned = false;
      dragging = { x: ev.clientX, y: ev.clientY, tx: this.transform.x, ty: this.transform.y };
      this.svg.setPointerCapture(ev.pointerId);
      this.svg.classList.add("panning");
    });
    this.svg.addEventListener("pointermove", (ev) => {
      if (!dragging) return;
      if (Math.abs(ev.clientX - dragging.x) + Math.abs(ev.clientY - dragging.y) > 4) this.panned = true;
      this.transform.x = dragging.tx + (ev.clientX - dragging.x);
      this.transform.y = dragging.ty + (ev.clientY - dragging.y);
      this.#applyTransform();
    });
    const end = () => {
      dragging = null;
      this.svg.classList.remove("panning");
    };
    this.svg.addEventListener("pointerup", end);
    this.svg.addEventListener("pointercancel", end);

    this.svg.addEventListener(
      "wheel",
      (ev) => {
        ev.preventDefault();
        const rect = this.svg.getBoundingClientRect();
        const px = ev.clientX - rect.left;
        const py = ev.clientY - rect.top;
        const factor = Math.exp(-ev.deltaY * 0.0015);
        const k = Math.min(2.5, Math.max(0.2, this.transform.k * factor));
        const ratio = k / this.transform.k;
        this.transform = {
          k,
          x: px - (px - this.transform.x) * ratio,
          y: py - (py - this.transform.y) * ratio,
        };
        this.#applyTransform();
      },
      { passive: false }
    );
  }
}
