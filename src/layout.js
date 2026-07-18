export const NODE_W = 208;
export const NODE_H = 56;
export const COL_GAP = 84; // horizontal space between stage lanes (wire channel)
export const ROW_GAP = 26;
export const LANE_PAD_X = 24;
export const LANE_TOP = 74; // room for lane header
export const LANE_PAD_BOTTOM = 28;

/**
 * Layered layout: one column per stage, jobs ordered inside each column by
 * a few barycenter sweeps over the *drawable* edges to reduce wire crossings.
 *
 * Returns {
 *   positions: Map<name, {x, y}>,   // node top-left
 *   lanes: [{stage, x, w, h, count}],
 *   width, height,
 * }
 */
export function layoutPipeline(model, graph) {
  const { stages, jobs } = model;
  const columns = stages.map((stage) =>
    [...jobs.values()].filter((j) => j.stage === stage).map((j) => j.name)
  );
  columns.forEach((col) => col.sort((a, b) => a.localeCompare(b)));

  const colOf = new Map();
  columns.forEach((col, i) => col.forEach((n) => colOf.set(n, i)));

  const rank = new Map();
  const setRanks = () => {
    columns.forEach((col) => col.forEach((n, i) => rank.set(n, i)));
  };
  setRanks();

  const barycenter = (name, neighbors) => {
    const rel = [...neighbors].filter((n) => rank.has(n));
    if (rel.length === 0) return rank.get(name);
    return rel.reduce((s, n) => s + rank.get(n), 0) / rel.length;
  };

  // Alternate forward (order by predecessors) and backward sweeps.
  for (let sweep = 0; sweep < 4; sweep++) {
    const forward = sweep % 2 === 0;
    const adjacency = forward ? graph.upstream : graph.downstream;
    const range = forward
      ? columns.map((_, i) => i)
      : columns.map((_, i) => columns.length - 1 - i);
    for (const ci of range) {
      const col = columns[ci];
      const scores = new Map(col.map((n) => [n, barycenter(n, adjacency.get(n) ?? [])]));
      col.sort((a, b) => scores.get(a) - scores.get(b) || a.localeCompare(b));
      setRanks();
    }
  }

  const laneW = NODE_W + LANE_PAD_X * 2;
  const maxRows = Math.max(1, ...columns.map((c) => c.length));
  const height = LANE_TOP + maxRows * (NODE_H + ROW_GAP) - ROW_GAP + LANE_PAD_BOTTOM;

  const positions = new Map();
  const lanes = [];
  columns.forEach((col, ci) => {
    const laneX = ci * (laneW + COL_GAP);
    lanes.push({ stage: stages[ci], x: laneX, w: laneW, h: height, count: col.length });
    // Vertically center each column's block of jobs.
    const blockH = col.length * (NODE_H + ROW_GAP) - ROW_GAP;
    const startY = LANE_TOP + (height - LANE_TOP - LANE_PAD_BOTTOM - blockH) / 2;
    col.forEach((name, ri) => {
      positions.set(name, { x: laneX + LANE_PAD_X, y: startY + ri * (NODE_H + ROW_GAP) });
    });
  });

  const width = columns.length * laneW + (columns.length - 1) * COL_GAP;
  return { positions, lanes, width, height };
}

/**
 * Orthogonal schematic wire from source right edge to target left edge.
 * Rounded elbows; vertical run happens in the channel between lanes,
 * offset per-edge (`slot`) so parallel wires don't overlap.
 */
export function wirePath(from, to, slot = 0, slots = 1) {
  const sx = from.x + NODE_W;
  const sy = from.y + NODE_H / 2;
  const tx = to.x;
  const ty = to.y + NODE_H / 2;
  const r = 8;

  if (Math.abs(ty - sy) < 1) return `M ${sx} ${sy} L ${tx} ${ty}`;

  // Spread vertical runs across the channel before the target lane.
  const channelLeft = tx - COL_GAP + 18;
  const channelRight = tx - 18;
  const t = slots <= 1 ? 0.5 : (slot + 1) / (slots + 1);
  const mx = channelLeft + (channelRight - channelLeft) * t;

  const dy = ty > sy ? 1 : -1;
  const rr = Math.min(r, Math.abs(ty - sy) / 2, Math.abs(mx - sx), Math.abs(tx - mx));
  return [
    `M ${sx} ${sy}`,
    `L ${mx - rr} ${sy}`,
    `Q ${mx} ${sy} ${mx} ${sy + rr * dy}`,
    `L ${mx} ${ty - rr * dy}`,
    `Q ${mx} ${ty} ${mx + rr} ${ty}`,
    `L ${tx} ${ty}`,
  ].join(" ");
}
