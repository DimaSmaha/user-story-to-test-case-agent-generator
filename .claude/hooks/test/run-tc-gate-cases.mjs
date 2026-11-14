// Offline test cases for the gt-test-case-generator feedback loop (.claude/hooks/tc-gate.mjs, one LLM call per review).
//
//   node .claude/hooks/test/run-tc-gate-cases.mjs [--model <model>] [--case <substr>[,<substr>]]
//                                                 [--verbose] [--keep] [--json <out.json>]
//   npm run test:tc-gate                       # model from the hook command in gt-test-case-generator/SKILL.md
//   npm run test:tc-gate -- --case c5,c6       # only some cases (c6 cases need no model)
//
// Each gate call that reaches the reviewer costs one real model call (~15–30 s). Cases c6-* never reach it.
//
// No skill or script runs here — the runner plays generate-tc.sh / batch-generate-tc.sh. fixtures/tc/_base/ holds a
// valid run folder exactly as the script writes it (us.json, test-ideas.json, tc-N.json, tc-steps-N.md/.xml;
// "{{RUN_DIR}}" in JSON files becomes the run folder). Each case folder holds only the files that differ, plus case.json:
//   description, command ("batch" | "batch-no-us-id" | a raw command with {{RUN_ID}}), expect (outcome sequence),
//   fix ("regenerate" = after the first BLOCK restore the base tc files, which is what deleting them and re-running
//   the deterministic script produces), fix_command, model, remove, probe, assert
// Every call after the first is the "agent" running the same command again (after the fix, if any).
//
// Outcomes:
//   PASS        status PASSED                       BLOCK      {"decision":"block"}, status RETRYING
//   FINAL       block, status FAILED (retries used up: "reply with the failure report")
//   SILENT      no feedback, status FAILED          UNVERIFIED reviewer could not run
//   NO_RUN_DIR  run folder not resolvable (no model)  IGNORED  not a generator command: no output, no status
// For defects the expectation is BLOCK; a PASS is reported as a false pass, a BLOCK on a correct folder as a false
// fail — that is how the LLM reviewer itself is evaluated. Exit code 1 on any mismatch.

import { writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  HERE, ROOT, ARTIFACTS, STATE_DIR, parseArgs, listCases, checkAsserts, mismatchKind, printRow, printSummary, lastJsonLine,
  readJson, readOrNull, parseJson,
} from "./harness-lib.mjs";

const FIXTURES = join(HERE, "fixtures", "tc");
const BASE = join(FIXTURES, "_base");
const GATE = join(ROOT, ".claude", "hooks", "tc-gate.mjs");
const SKILL_MD = join(ROOT, ".claude", "skills", "gt-test-case-generator", "SKILL.md");
const SCRIPTS = ".claude/skills/gt-test-case-generator/scripts";
const REVIEWED = new Set(["PASS", "BLOCK", "FINAL", "SILENT"]);

const args = parseArgs(process.argv.slice(2), { "--model": "model" });
const model = args.model ?? skillModel();

const cases = listCases(FIXTURES, args.case);
console.log(`tc-gate cases — model: ${model}${args.model ? " (--model override)" : " (from gt-test-case-generator/SKILL.md)"}\n`);

const results = [];
for (const name of cases) {
  const r = runCase(name);
  results.push(r);
  printRow(r, { verbose: args.verbose, feedbackOutcomes: ["BLOCK", "FINAL"], extra: (x) => `  model calls=${x.model_calls}` });
}

printSummary(results, "the LLM reviewer");
const probes = results.filter((r) => r.probe && r.result !== "skipped");
if (probes.length) console.log(`probes (exact-comparison checks done by the LLM): ${probes.map((r) => `${r.name} ${r.result === "ok" ? "caught" : "MISSED"}`).join(", ")}`);
if (args.json) writeFileSync(resolve(args.json), JSON.stringify({ model, results }, null, 2) + "\n");
process.exit(results.some((r) => r.result === "MISMATCH") ? 1 : 0);

// ── one case ──────────────────────────────────────────────────────────────────

function runCase(name) {
  const dir = join(FIXTURES, name);
  const spec = readJson(join(dir, "case.json"));
  const expected = spec.expect;
  const runId = `gate-test-tc-${name}`;
  const runDir = join(ARTIFACTS, runId);
  const runRel = `.workflow-artifacts/${runId}`;

  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  copyTree(BASE, runDir, runRel, () => true);
  copyTree(dir, runDir, runRel, (f) => f !== "case.json");
  for (const f of spec.remove ?? []) rmSync(join(runDir, f), { force: true });

  const sessionId = `harness-tc-${name}-${Date.now()}`;
  const caseModel = spec.model ?? model;
  let command = buildCommand(spec.command, runRel, runId);

  const steps = [];
  let fixApplied = false;
  try {
    for (let i = 0; i < expected.length; i++) {
      let label = i === 0 ? "runs the script" : "runs the same command again";
      if (i > 0 && steps.at(-1).outcome === "BLOCK" && spec.fix === "regenerate" && !fixApplied) {
        // Delete the flagged files and re-run: the deterministic script writes exactly the base files again.
        copyTree(BASE, runDir, runRel, (f) => /^tc-/.test(f));
        if (spec.fix_command) command = buildCommand(spec.fix_command, runRel, runId);
        fixApplied = true;
        label = "deletes tc files, re-runs the script";
      }
      const step = callGate({ runDir, command, sessionId, model: caseModel });
      step.label = label;
      steps.push(step);
      if (["IGNORED", "NO_RUN_DIR", "GATE_ERROR"].includes(step.outcome)) break;
    }
  } finally {
    rmSync(join(STATE_DIR, `tc-gate-${runId}.json`), { force: true });
    if (!args.keep) rmSync(runDir, { recursive: true, force: true });
  }

  const actual = steps.map((s) => s.outcome);
  const modelCalls = steps.filter((s) => REVIEWED.has(s.outcome) && s.status && s.status.cached !== true).length;
  const sameSequence = actual.join(" ") === expected.join(" ");
  const assertErrors = sameSequence ? [...checkAsserts(spec.assert ?? {}, steps), ...tcAsserts(spec.assert ?? {}, steps, modelCalls)] : [];
  const lastStatus = [...steps].reverse().find((s) => s.status)?.status ?? null;
  return {
    name,
    expected,
    actual,
    result: sameSequence && assertErrors.length === 0 ? "ok" : "MISMATCH",
    kind: sameSequence ? (assertErrors.length ? "assertion failed" : null) : mismatchKind(expected, actual),
    assert_errors: assertErrors,
    probe: Boolean(spec.probe),
    fix_applied: fixApplied,
    retries: lastStatus?.retries ?? null,
    model_calls: modelCalls,
    ms: steps.map((s) => s.ms),
    steps: steps.map(({ outcome, ms, status, reason, label }) => ({ outcome, ms, label, cached: status?.cached ?? false, notes: status?.notes ?? [], reason })),
  };
}

function tcAsserts(a, steps, modelCalls) {
  const errors = [];
  const lastStatus = [...steps].reverse().find((s) => s.status)?.status ?? {};
  if ("model_calls" in a && modelCalls !== a.model_calls) errors.push(`${modelCalls} model calls, expected ${a.model_calls}`);
  if (a.indices && JSON.stringify(lastStatus.indices) !== JSON.stringify(a.indices)) {
    errors.push(`reviewed indices ${JSON.stringify(lastStatus.indices)}, expected ${JSON.stringify(a.indices)}`);
  }
  return errors;
}

// ── one gate call (one successful script run) ────────────────────────────────

function callGate({ runDir, command, sessionId, model }) {
  const statusPath = join(runDir, "tc.validation.json");
  const before = readOrNull(statusPath);
  const input = {
    session_id: sessionId,
    transcript_path: "",
    cwd: ROOT,
    permission_mode: "default",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command, description: "Generate test cases" },
    tool_response: { stdout: fakeStdout(command, runDir), stderr: "", interrupted: false, isImage: false },
  };
  const env = { ...process.env, CLAUDE_PROJECT_DIR: ROOT };
  delete env.TC_GATE_CHILD; // the gate is a no-op when this is set

  const t0 = Date.now();
  const run = spawnSync(process.execPath, [GATE, "--model", model], { cwd: ROOT, input: JSON.stringify(input), env, encoding: "utf8", timeout: 300_000, windowsHide: true });
  const ms = Date.now() - t0;

  const out = lastJsonLine(run.stdout);
  const after = readOrNull(statusPath);
  const status = parseJson(after);
  const msg = String(out.systemMessage ?? "");
  const reason = String(out.reason ?? msg);

  let outcome;
  if (run.error || run.status !== 0 || msg.startsWith("tc-gate crashed")) outcome = "GATE_ERROR";
  else if (out.decision === "block") outcome = status?.status === "FAILED" ? "FINAL" : "BLOCK";
  else if (/could not resolve/.test(msg)) outcome = "NO_RUN_DIR";
  else if (/missing or not a JSON array/.test(msg)) outcome = "NO_IDEAS";
  else if (after === before) outcome = "IGNORED";
  else if (status?.status === "PASSED") outcome = "PASS";
  else if (status?.status === "UNVERIFIED") outcome = "UNVERIFIED";
  else if (status?.status === "FAILED") outcome = "SILENT";
  else outcome = `UNKNOWN(${status?.status ?? "no status"})`;

  return {
    outcome,
    ms,
    status: after === before ? null : status,
    feedback: out.decision === "block",
    reason: outcome === "GATE_ERROR" ? reason || run.stderr || String(run.error) : reason,
  };
}

/** What the script would print: the batch summary, or tc-N.json for a single index. Context only for the reviewer. */
function fakeStdout(command, runDir) {
  const single = /generate-tc\.sh\b[\s\S]*--index\s+(\d+)/.exec(command);
  if (/batch-generate-tc\.sh/.test(command)) {
    const tcs = existsSync(runDir) ? readdirSync(runDir).filter((f) => /^tc-\d+\.json$/.test(f)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) : [];
    const lines = tcs.map((f) => {
      const tc = parseJson(readOrNull(join(runDir, f))) ?? {};
      return `  [SKIP]  scenario ${String(tc.scenario_index).padEnd(3)} ${tc.title ?? "?"}`;
    });
    return [`Batch TC generation: ${tcs.length} scenarios  (max_retries=3  retry_delay=5s)`, "─".repeat(64), ...lines, "─".repeat(64), `Results: 0 passed | 0 failed | ${tcs.length} skipped`].join("\n") + "\n";
  }
  if (single && /gt-test-case-generator/.test(command)) return readOrNull(join(runDir, `tc-${single[1]}.json`)) ?? "";
  return "";
}

function buildCommand(kind, runRel, runId) {
  const ideas = `--ideas-file "${runRel}/test-ideas.json" --run-dir "${runRel}"`;
  if (kind === "batch") return `bash ${SCRIPTS}/batch-generate-tc.sh ${ideas} --us-id 114`;
  if (kind === "batch-no-us-id") return `bash ${SCRIPTS}/batch-generate-tc.sh ${ideas}`;
  return String(kind).replaceAll("{{RUN_ID}}", runId);
}

/** Copy the files of `from` that pass `keep` into `to`; "{{RUN_DIR}}" in JSON files becomes the run folder. */
function copyTree(from, to, runRel, keep) {
  for (const f of readdirSync(from)) {
    if (!keep(f)) continue;
    const text = readFileSync(join(from, f), "utf8");
    writeFileSync(join(to, f), f.endsWith(".json") ? text.replaceAll("{{RUN_DIR}}", runRel) : text);
  }
}

function skillModel() {
  const m = /tc-gate\.mjs.*--model[=\s]+([\w.-]+)/.exec(readOrNull(SKILL_MD) ?? "");
  return m ? m[1] : "sonnet"; // the gate's own default
}
