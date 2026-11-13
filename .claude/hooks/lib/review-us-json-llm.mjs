// Case 3 — "llm": one plain LLM call, no tools.
//
// us.json and tracker-source.json (same folder) are pasted into the prompt; the model answers
// once, as SDK structured output. The rules (system prompt) and model come from the body and
// frontmatter of .claude/agents/us-json-reviewer.md, so cases 1 and 3 judge by the same contract
// and differ only in mechanism (agent with tools vs single call).
//
// Isolation: settingSources: [] → no hooks, CLAUDE.md, skills or agents are loaded.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const TIMEOUT_MS = 180_000;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["PASS", "FAIL"] },
    notes: { type: "array", items: { type: "string" } },
  },
  required: ["verdict", "notes"],
  additionalProperties: false,
};

/**
 * @returns {Promise<{ verdict: "PASS"|"FAIL", notes: string[] } | { error: string }>}
 *          `error` = the reviewer itself could not run (auth, timeout, bad output) — not a verdict.
 */
export async function reviewWithLlm({ projectDir, usPath }) {
  let sdk;
  let rules;
  try {
    const require = createRequire(join(projectDir, "package.json"));
    sdk = await import(pathToFileURL(require.resolve("@anthropic-ai/claude-agent-sdk")).href);
    rules = loadRules(projectDir);
  } catch (e) {
    return { error: `llm setup failed: ${e.message}` };
  }

  const usAbs = join(projectDir, usPath);
  const sourcePath = join(dirname(usPath), "tracker-source.json").split("\\").join("/");
  const source = readOrNull(join(projectDir, sourcePath));
  const prompt = [
    `Review ${usPath}. You have no tools — both files are pasted below.`,
    ``,
    `${usPath}:`,
    "```json",
    readOrNull(usAbs) ?? "(file not found)",
    "```",
    ``,
    source === null ? `${sourcePath}: does not exist (pasted story)` : `${sourcePath}:\n\`\`\`json\n${source}\n\`\`\``,
  ].join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const stream = sdk.query({
      prompt,
      options: {
        cwd: projectDir,
        systemPrompt: rules.systemPrompt,
        model: rules.model,
        tools: [],
        settingSources: [],
        maxTurns: 3,
        persistSession: false,
        abortController: controller,
        outputFormat: { type: "json_schema", schema: OUTPUT_SCHEMA },
        env: { ...process.env, US_GATE_CHILD: "1" },
      },
    });
    for await (const msg of stream) {
      if (msg.type !== "result") continue;
      if (msg.subtype !== "success" || msg.is_error) {
        return { error: `llm ended with ${msg.subtype}${msg.result ? `: ${msg.result}` : ""}` };
      }
      const out = msg.structured_output;
      if (out && (out.verdict === "PASS" || out.verdict === "FAIL") && Array.isArray(out.notes)) {
        return { verdict: out.verdict, notes: out.notes.map(String) };
      }
      return { error: `llm returned no structured verdict: ${String(msg.result).slice(0, 300)}` };
    }
    return { error: "llm stream ended without a result" };
  } catch (e) {
    return { error: controller.signal.aborted ? `llm timed out after ${TIMEOUT_MS / 1000}s` : `llm failed: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Parse `---\nfrontmatter\n---\nbody` from the agent definition file. */
function loadRules(projectDir) {
  const raw = readFileSync(join(projectDir, ".claude", "agents", "us-json-reviewer.md"), "utf8");
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { model: undefined, systemPrompt: raw };
  return { model: m[1].match(/^model:\s*(\S+)\s*$/m)?.[1], systemPrompt: m[2].trim() };
}

function readOrNull(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
