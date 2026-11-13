// Case 1 — "subagent": run the .claude/agents/us-json-reviewer.md agent as-is, via the CLI:
//
//   claude -p "Review <path>" --agent us-json-reviewer --setting-sources project
//          --no-session-persistence --output-format json --json-schema <schema>
//
// Claude Code applies the whole .md: body = system prompt (the rules), `tools`, `model`.
// The agent reads us.json + tracker-source.json itself, so the prompt only names the file.
// The verdict comes back as `structured_output` (works because the .md's `tools` list
// includes StructuredOutput).
//
// Why the CLI and not the Agent SDK's `agent` option: the SDK's bundled CLI (0.2.x) applies the
// .md's tools/model but NOT its body, so the agent reviewed without the rules.
//
// Needs `claude` on PATH (override with CLAUDE_BIN). Recursion safety: the nested session loads
// project settings, but the gate's SubagentStop matcher only matches "story-planner", and
// US_GATE_CHILD=1 makes the gate a no-op inside the nested session anyway.

import { spawn } from "node:child_process";

const AGENT_NAME = "us-json-reviewer";
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
 *          `error` = the reviewer itself could not run (CLI missing, auth, timeout, bad output) — not a verdict.
 */
export async function reviewWithSubagent({ projectDir, usPath }) {
  const args = [
    "-p", `Review ${usPath}`,
    "--agent", AGENT_NAME,
    "--setting-sources", "project",
    "--no-session-persistence",
    "--output-format", "json",
    "--json-schema", JSON.stringify(OUTPUT_SCHEMA),
  ];

  let run;
  try {
    run = await runCli(process.env.CLAUDE_BIN || "claude", args, projectDir);
  } catch (e) {
    return { error: `subagent could not start: ${e.message}` };
  }
  if (run.timedOut) return { error: `subagent timed out after ${TIMEOUT_MS / 1000}s` };

  let result;
  try {
    result = JSON.parse(run.stdout.trim().split(/\r?\n/).pop());
  } catch {
    return { error: `subagent exited ${run.code} without JSON output: ${(run.stderr || run.stdout).slice(-300)}` };
  }
  if (result.subtype !== "success" || result.is_error) {
    return { error: `subagent ended with ${result.subtype}${result.result ? `: ${result.result}` : ""}` };
  }
  const out = result.structured_output;
  if (out && (out.verdict === "PASS" || out.verdict === "FAIL") && Array.isArray(out.notes)) {
    return { verdict: out.verdict, notes: out.notes.map(String) };
  }
  return { error: `subagent returned no structured verdict (is StructuredOutput in the .md tools?): ${String(result.result).slice(0, 300)}` };
}

function runCli(bin, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env: { ...process.env, US_GATE_CHILD: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, TIMEOUT_MS);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}
