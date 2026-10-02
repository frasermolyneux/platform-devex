import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function classifyAutomation(pr, repository) {
  if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("repository must be in owner/repo form");
  }
  const head = pr?.head;
  const base = pr?.base;
  if (!Number.isSafeInteger(head?.repo?.id) || head.repo.id <= 0 ||
      head.repo.id !== base?.repo?.id || head.repo.full_name !== repository ||
      base.repo.full_name !== repository || typeof head.ref !== "string") {
    return null;
  }
  const author = pr.user?.login;
  if (["Copilot", "copilot-swe-agent[bot]"].includes(author) && head.ref.startsWith("copilot/")) {
    return "copilot";
  }
  if (author === "dependabot[bot]" && head.ref.startsWith("dependabot/")) {
    return "dependabot";
  }
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pr = JSON.parse(readFileSync(0, "utf8"));
  console.log(classifyAutomation(pr, process.argv[2]) ?? "manual-or-untrusted");
}
