/**
 * Minimal GitLab REST v4 client for fetching a project's CI config and the
 * latest pipeline's job statuses. Runs entirely in the browser; the token is
 * held in memory only.
 */
async function glFetch(base, path, token) {
  const headers = { Accept: "application/json" };
  if (token) headers["PRIVATE-TOKEN"] = token;
  let res;
  try {
    res = await fetch(`${base}/api/v4/${path}`, { headers });
  } catch (e) {
    throw new Error(
      `Network error reaching ${base} — check the URL, your connection, or CORS policy of a self-hosted instance.`
    );
  }
  if (res.status === 401) throw new Error("401 Unauthorized — token missing or invalid (needs read_api scope).");
  if (res.status === 403) throw new Error("403 Forbidden — token lacks access to this project.");
  if (res.status === 404) throw new Error("404 Not Found — check the project path and ref (private projects need a token).");
  if (!res.ok) throw new Error(`GitLab API error ${res.status}: ${await res.text()}`);
  return res;
}

/**
 * Fetch { ciYaml, statuses, pipeline } for a project+ref.
 * statuses: Map<jobName, {status, duration, web_url, runner}> from the latest
 * pipeline on the ref (null if the ref has no pipelines).
 */
export async function fetchProject({ baseUrl, projectPath, ref, token }) {
  const base = baseUrl.replace(/\/+$/, "");
  const proj = encodeURIComponent(projectPath.trim().replace(/^\/+|\/+$/g, ""));

  const fileRes = await glFetch(
    base,
    `projects/${proj}/repository/files/${encodeURIComponent(".gitlab-ci.yml")}/raw?ref=${encodeURIComponent(ref)}`,
    token
  );
  const ciYaml = await fileRes.text();

  let pipeline = null;
  const statuses = new Map();
  try {
    const pipes = await (
      await glFetch(base, `projects/${proj}/pipelines?ref=${encodeURIComponent(ref)}&per_page=1`, token)
    ).json();
    if (pipes.length > 0) {
      pipeline = pipes[0];
      // include manual/skipped jobs too; paginate up to 300 jobs
      for (let page = 1; page <= 3; page++) {
        const jobs = await (
          await glFetch(base, `projects/${proj}/pipelines/${pipeline.id}/jobs?per_page=100&page=${page}`, token)
        ).json();
        for (const j of jobs) {
          // Parallel jobs appear as "name 1/3" — collapse onto the base name,
          // keeping the "worst" status so failures surface.
          const baseName = j.name.replace(/ \d+\/\d+$/, "").replace(/: \[.*\]$/, "");
          const prev = statuses.get(baseName);
          const rank = { failed: 5, running: 4, pending: 3, manual: 2, success: 1 };
          if (!prev || (rank[j.status] ?? 0) > (rank[prev.status] ?? 0)) {
            statuses.set(baseName, {
              status: j.status,
              duration: j.duration,
              web_url: j.web_url,
              runner: j.runner?.description ?? null,
            });
          }
        }
        if (jobs.length < 100) break;
      }
    }
  } catch (e) {
    // Pipeline status is best-effort; the config alone is still useful.
    console.warn("Pipeline status fetch failed:", e);
  }

  return { ciYaml, statuses, pipeline };
}
