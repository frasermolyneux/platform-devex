import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseObjectResponse, ResponseError, runReadOnlyAnalysis } from "../../../scripts/copilot-analysis.mjs";
import { GitHubApi } from "../../../scripts/continuous-improvement.mjs";
import { latestPullRequestRuns } from "./workflow-runs.mjs";
import { previousRiskBlock } from "./approval-audit.mjs";

export function validRiskDecision(value) {
  return Object.keys(value).sort().join(",") === "reason,touches_ci,verdict" &&
    ["approve", "block"].includes(value.verdict) && typeof value.touches_ci === "boolean" &&
    typeof value.reason === "string" && value.reason.trim().length > 0 && value.reason.length <= 500 &&
    !/[\u0000-\u001f]/.test(value.reason);
}

export async function reviewRisk(prompt, run = runReadOnlyAnalysis, options = {}, canRetry = async () => true) {
  let last;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await run(prompt + (attempt === 2
        ? "\nThe previous response failed the JSON protocol. Return ONLY the exact single JSON object requested, with no extra keys, markdown or prose."
        : ""), options);
      const decision = parseObjectResponse(response, validRiskDecision);
      return { ...decision, diagnostics: { category: "valid", attempts: attempt, bytes: Buffer.byteLength(response) } };
    } catch (error) {
      if (!(error instanceof ResponseError)) {
        return { verdict: "block", touches_ci: true, reason: "Copilot SDK failed; human approval required",
          diagnostics: { category: "sdk_failure", attempts: attempt, bytes: 0 } };
      }
      last = error;
      if (attempt === 1 && !await canRetry()) {
        return { verdict: "block", touches_ci: true, reason: "PR/workflow state changed; stale review discarded",
          diagnostics: { category: "state_changed", attempts: 1, bytes: error.bytes } };
      }
    }
  }
  return { verdict: "block", touches_ci: true, reason: `Copilot response rejected (${last.category}); human approval required`,
    diagnostics: { category: last.category, attempts: 2, bytes: last.bytes } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const prompt = await readFile(process.argv[2], "utf8");
    const api = new GitHubApi(process.env.GH_TOKEN);
    const repo = process.env.REPOSITORY;
    const number = Number(process.env.REVIEW_PR_NUM);
    const priorBlock = await previousRiskBlock(api, repo, number, process.env.BOT_LOGIN,
      process.env.REVIEW_HEAD_SHA, process.env.REVIEW_BASE_SHA);
    const result = priorBlock ? { ...priorBlock, diagnostics: { category: "valid", attempts: 0, bytes: 0 } }
      : await reviewRisk(prompt, runReadOnlyAnalysis, {
      token: process.env.COPILOT_TOKEN, model: process.env.COPILOT_MODEL,
    }, async () => {
      const pr = await api.request(`/repos/${repo}/pulls/${number}`);
      if (pr.state !== "open" || pr.draft || pr.head?.sha !== process.env.REVIEW_HEAD_SHA ||
          pr.base?.sha !== process.env.REVIEW_CURRENT_BASE_SHA ||
          pr.head?.repo?.full_name !== repo || pr.base?.repo?.full_name !== repo) return false;
      const latest = latestPullRequestRuns(await api.workflowRuns(repo, pr.head.sha), number, pr.head.sha);
      return latest.some((run) => run.id === Number(process.env.REVIEW_RUN_ID) &&
        (run.conclusion === "action_required" || run.status === "action_required"));
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.diagnostics.category !== "valid") {
      console.error(`Risk review failed closed: ${result.diagnostics.category}; attempts=${result.diagnostics.attempts}; bytes=${result.diagnostics.bytes}`);
      process.exitCode = 1;
    }
  } catch {
    console.error("Risk review transport/setup failed; response and credentials withheld");
    process.exitCode = 1;
  }
}
