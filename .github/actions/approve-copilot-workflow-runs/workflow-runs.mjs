import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function collectWorkflowRuns(pages) {
  if (!Array.isArray(pages) || !pages.length ||
      pages.some((page) => !Number.isSafeInteger(page?.total_count) || page.total_count < 0 ||
        page.total_count !== pages[0].total_count || !Array.isArray(page.workflow_runs))) {
    throw new Error("Invalid or changing workflow run history");
  }
  const runs = pages.flatMap((page) => page.workflow_runs);
  if (runs.length !== pages[0].total_count || runs.length > 1000 ||
      new Set(runs.map((run) => run.id)).size !== runs.length) {
    throw new Error("Incomplete or duplicate workflow run history");
  }
  return runs;
}

export function latestPullRequestRuns(runs, number, sha) {
  if (!Array.isArray(runs) || !Number.isSafeInteger(number) || number < 1 ||
      typeof sha !== "string" || !sha) {
    throw new Error("Invalid pull request workflow selection");
  }
  const latest = new Map();
  for (const run of runs) {
    if (run.event !== "pull_request" || run.head_sha !== sha ||
        !run.pull_requests?.some((pr) => pr.number === number)) continue;
    if (!Number.isSafeInteger(run.id) || run.id < 1 ||
        !Number.isSafeInteger(run.workflow_id) || run.workflow_id < 1 ||
        !Number.isFinite(Date.parse(run.created_at))) {
      throw new Error("Invalid pull request workflow run metadata");
    }
    const previous = latest.get(run.workflow_id);
    if (!previous || Date.parse(run.created_at) > Date.parse(previous.created_at) ||
        (Date.parse(run.created_at) === Date.parse(previous.created_at) && run.id > previous.id)) {
      latest.set(run.workflow_id, run);
    }
  }
  return [...latest.values()];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runs = collectWorkflowRuns(JSON.parse(readFileSync(0, "utf8")));
  for (const run of latestPullRequestRuns(runs, Number(process.argv[2]), process.argv[3])) {
    console.log(run.id);
  }
}
