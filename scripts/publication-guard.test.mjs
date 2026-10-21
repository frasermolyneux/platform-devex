import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("publication installer unit and local git-patch integration suite", () => {
  const result = spawnSync(process.platform === "win32" ? "python" : "python3",
    ["scripts/publication_guard_test.py"], {
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
