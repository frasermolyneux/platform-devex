import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class ResponseError extends Error {
  constructor(category, bytes = 0) {
    super(`Copilot response rejected: ${category} (${bytes} bytes)`);
    this.category = category;
    this.bytes = bytes;
  }
}

export class AnalysisError extends Error {
  constructor() {
    super("Copilot SDK analysis failed; response and credentials withheld");
  }
}

export function parseObjectResponse(text, validate = () => true) {
  const bytes = typeof text === "string" ? Buffer.byteLength(text) : 0;
  if (!bytes || !text.trim()) throw new ResponseError("empty_response", bytes);
  if (bytes > 32_768) throw new ResponseError("oversized_response", bytes);
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new ResponseError("invalid_json", bytes);
  }
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new ResponseError("invalid_schema", bytes);
  }
  // JSON.parse accepts duplicate keys; reject that ambiguous framing, including escaped keys.
  const stack = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "{") stack.push(new Set());
    else if (char === "[") stack.push(null);
    else if (char === "}" || char === "]") stack.pop();
    else if (char === '"') {
      const start = index++;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === "\\") index++;
        index++;
      }
      if (text.slice(index + 1).trimStart().startsWith(":")) {
        const key = JSON.parse(text.slice(start, index + 1));
        const keys = stack.at(-1);
        if (keys?.has(key)) throw new ResponseError("duplicate_key", bytes);
        keys?.add(key);
      }
    }
  }
  if (!validate(value)) throw new ResponseError("invalid_schema", bytes);
  return value;
}

export async function runReadOnlyAnalysis(prompt, {
  token = process.env.COPILOT_AGENT_PAT,
  model = "auto",
  createClient = async (options) => {
    const { CopilotClient } = await import("@github/copilot-sdk");
    return new CopilotClient(options);
  },
} = {}) {
  if (!token) throw new Error("A human Copilot token is required for SDK analysis");
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/(TOKEN|SECRET|PASSWORD|PRIVATE_KEY|_PEM|_PAT)$/i.test(key)) delete env[key];
  }
  const baseDirectory = await mkdtemp(join(tmpdir(), "platform-devex-ci-sdk-"));
  let client;
  try {
    client = await createClient({ mode: "empty", baseDirectory, useLoggedInUser: false, env });
    const session = await client.createSession({
      model, gitHubToken: token, availableTools: [], skipCustomInstructions: true,
      onPermissionRequest: () => ({ kind: "reject", feedback: "Analysis must be read-only." }),
      sessionLimits: { maxAiCredits: 30 },
    });
    const response = await session.sendAndWait({ prompt }, 120_000);
    if (typeof response?.data?.content !== "string") throw new ResponseError("empty_response");
    return response.data.content;
  } catch (error) {
    if (error instanceof ResponseError) throw error;
    throw new AnalysisError();
  } finally {
    try {
      try {
        if (client) await client.stop();
      } finally {
        await rm(baseDirectory, { recursive: true, force: true });
      }
    } catch {
      throw new AnalysisError();
    }
  }
}
