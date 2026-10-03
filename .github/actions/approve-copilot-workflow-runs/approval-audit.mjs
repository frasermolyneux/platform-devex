import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { GitHubApi } from "../../../scripts/continuous-improvement.mjs";
import { classifyAutomation } from "../delegate-failed-checks/eligibility.mjs";
import { latestPullRequestRuns } from "./workflow-runs.mjs";
import { marker, readMarker } from "../../../scripts/review-lifecycle.mjs";

const TAG = "<!-- devex-copilot-approve -->";
const HISTORY = "<!-- devex-copilot-approval-history -->";

export function updatedAuditBody(previous, current, timestamp) {
  if (previous?.split(`\n\n${HISTORY}`)[0] === current) return null;
  if (!previous) return current;
  const body = `${current}\n\n${HISTORY}\n<details>\n<summary>Previous decision (${timestamp})</summary>\n\n${previous}\n\n</details>`;
  if (body.length > 65_000) throw new Error("Approval audit history exceeds the comment limit");
  return body;
}

export async function previousRiskBlock(api, repo, number, botLogin, sha, base) {
  if (!botLogin) throw new Error("An exact App bot login is required for persistent risk decisions");
  const comments = await api.pages(`/repos/${repo}/issues/${number}/comments`);
  for (const comment of [...comments].reverse()) {
    if (comment.user?.login !== botLogin || !comment.body?.includes(`<!-- sha:${sha}:${base} -->`)) continue;
    const record = readMarker(comment.body, "devex-copilot-risk-decision");
    if (record) {
      if (Object.keys(record).sort().join(",") !== "base,reason,sha,touches_ci,verdict" ||
          record.sha !== sha || record.base !== base || record.verdict !== "block" ||
          typeof record.touches_ci !== "boolean" || typeof record.reason !== "string" ||
          !record.reason.trim() || record.reason.length > 500 || /[\u0000-\u001f]/.test(record.reason)) {
        throw new Error("Malformed trusted persistent risk decision; human assessment required");
      }
      return record;
    }
    if (comment.body.includes("Left workflow run(s) for this commit pending manual approval") &&
        comment.body.includes("model recommended human review:")) {
      return { sha, base, verdict: "block", touches_ci: true,
        reason: "Prior validated model review blocked this same head/base; human approval required" };
    }
  }
  return null;
}

export async function upsertAudit(api, repo, number, botLogin, sha, base, current, expectedCommentId) {
  if (!botLogin) throw new Error("An exact App bot login is required for approval audit ownership");
  const comments = await api.pages(`/repos/${repo}/issues/${number}/comments`);
  const previous = comments.findLast((comment) => (expectedCommentId === undefined || comment.id === expectedCommentId) &&
    comment.user?.login === botLogin &&
    comment.body?.includes(TAG) && comment.body.includes(`<!-- sha:${sha}:${base} -->`));
  if (expectedCommentId !== undefined && !previous) throw new Error("Owned audit comment changed before update");
  const body = updatedAuditBody(previous?.body, current, previous?.updated_at ?? previous?.created_at ?? "recorded earlier");
  if (body === null) return "unchanged";
  await api.request(previous ? `/repos/${repo}/issues/comments/${previous.id}` : `/repos/${repo}/issues/${number}/comments`, {
    method: previous ? "PATCH" : "POST", body: { body },
  });
  return previous ? "updated" : "created";
}

export async function refreshCompletedAudits(api, repo, botLogin, dryRun = false) {
  if (!botLogin) throw new Error("An exact App bot login is required for approval audit reconciliation");
  const pulls = await api.pages(`/repos/${repo}/pulls?state=open`);
  let updated = 0;
  for (const pr of pulls) {
    if (pr.draft || !classifyAutomation(pr, repo)) continue;
    const comments = await api.pages(`/repos/${repo}/issues/${pr.number}/comments`);
    const warnings = comments.filter((comment) => comment.user?.login === botLogin &&
      comment.body?.includes(TAG) && comment.body.includes(`<!-- sha:${pr.head.sha}:`) &&
      comment.body.split(`\n\n${HISTORY}`)[0].includes("Left workflow run(s) for this commit pending manual approval"));
    if (!warnings.length) continue;
    const latest = latestPullRequestRuns(await api.workflowRuns(repo, pr.head.sha), pr.number, pr.head.sha);
    if (!latest.length || latest.some((run) => run.status !== "completed" ||
        !["success", "skipped"].includes(run.conclusion)) ||
        !latest.some((run) => run.run_attempt > 1 && run.triggering_actor?.login === botLogin)) continue;
    const currentPr = await api.request(`/repos/${repo}/pulls/${pr.number}`);
    if (currentPr.state !== "open" || currentPr.draft || currentPr.head?.sha !== pr.head.sha ||
        !classifyAutomation(currentPr, repo)) continue;
    const fresh = latestPullRequestRuns(await api.workflowRuns(repo, pr.head.sha), pr.number, pr.head.sha);
    if (JSON.stringify(fresh) !== JSON.stringify(latest)) continue;
    for (const warning of warnings) {
      const tuple = warning.body.match(new RegExp(`<!-- sha:${pr.head.sha}:([a-f0-9]*) -->`));
      if (!tuple) continue;
      const body = `${TAG}${tuple[0]}\nCurrent validation state: the latest eligible workflow runs for this commit completed successfully after later release (${latest.map((run) => run.id).join(", ")}). The earlier pending-approval warning is historical, not the current validation state. Obsolete draft events may remain pending and are deliberately not rerun. This records execution state, not a new model approval.`;
      if (!dryRun && await upsertAudit(api, repo, pr.number, botLogin, pr.head.sha, tuple[1], body, warning.id) === "updated") updated++;
    }
  }
  return updated;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const api = new GitHubApi(process.env.GH_TOKEN);
    if (process.argv[2] === "reconcile") {
      console.log(await refreshCompletedAudits(api, process.env.REPOSITORY, process.env.BOT_LOGIN,
        process.env.DRY_RUN === "true"));
    } else if (process.argv[2] === "decision") {
      const record = process.env.REVIEW_RISK_RECORD ? JSON.parse(process.env.REVIEW_RISK_RECORD) : null;
      const body = await readFile(process.argv[3], "utf8") +
        (record ? `\n${marker("devex-copilot-risk-decision", record)}` : "");
      console.log(await upsertAudit(api, process.env.REPOSITORY, Number(process.env.REVIEW_PR_NUM),
        process.env.BOT_LOGIN, process.env.REVIEW_HEAD_SHA, process.env.REVIEW_BASE_SHA,
        body));
    } else throw new Error("Unknown approval-audit mode");
  } catch (error) {
    console.error(`Approval audit failed explicitly: ${error.message}`);
    process.exitCode = 1;
  }
}
