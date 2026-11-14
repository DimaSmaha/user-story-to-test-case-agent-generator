// Offline test cases for the gt-story-planner feedback loop (.claude/hooks/us-json-gate.mjs).
//
//   node .claude/hooks/test/run-us-json-gate-cases.mjs [--mode script|llm|subagent] [--case <substr>[,<substr>]]
//                                                      [--verbose] [--keep] [--json <out.json>]
//   npm run test:us-gate                      # mode from .claude/settings.json
//   npm run test:us-gate -- --mode llm        # one-off override
//
// Mode: read from .claude/settings.json (the --mode of the SubagentStop us-json-gate hook), so by default the
// harness tests the validator the live hook uses. --mode overrides it for one run. llm and subagent modes call
// a model once per gate call that reaches the validator (pre-check failures never do).
//
// No planner runs here — the runner plays the planner. Each fixture folder fixtures/us-json/<case>/ holds
// exactly what the gate would find in a run folder (us.json, tracker-source.json — either may be absent), plus:
//   case.json      description, expected outcome sequence per mode, optional us_id / last_message / env / assert
//   us.fixed.json  optional: the corrected us.json the "planner" writes after a BLOCK (closes the loop)
//
// Per case: copy the files into .workflow-artifacts/gate-test-<mode>-<case>/, write a fake subagent transcript that
// points at that folder (the same way a real planner's tool calls do), pipe a SubagentStop input into the gate,
// and classify each gate call:
//   PASS        stop allowed, us.validation.json → PASSED
//   BLOCK       {"decision":"block"}, status RETRYING   (feedback sent; the planner must fix and stop again)
//   FINAL       {"decision":"block"}, status FAILED     (retries used up: "reply with the failure report")
//   STOP        stop allowed, status file untouched     (the stop after the FAILED report)
//   BLOCKED     stop allowed, status FAILED + blocked   (the planner declared "BLOCKED: <reason>")
//   UNVERIFIED  stop allowed, status UNVERIFIED         (the reviewer itself could not run)
// The sequence ends at the first allowed stop, like a real subagent run.
//
// For llm/subagent a mismatch is an evaluator error against a labelled example — reported as a false pass
// (missed a defect) or a false fail (flagged a correct file). Exit code 1 on any mismatch.

import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync, copyFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");
const FIXTURES = join(HERE, "fixtures", "us-json");
const GATE = join(ROOT, ".claude", "hooks", "us-json-gate.mjs");
const ARTIFACTS = join(ROOT, ".workflow-artifacts");
const TRANSCRIPTS = join(ARTIFACTS, ".hook-test");
const STATE_DIR = join(ARTIFACTS, ".hook-state");
const MODES = ["script", "llm", "subagent"];
const ALLOWED_STOPS = new Set(["PASS", "STOP", "BLOCKED", "UNVERIFIED", "GATE_ERROR"]);

const args = parseArgs(process.argv.slice(2));
const mode = args.mode ?? settingsMode();
if (!MODES.includes(mode)) fatal(`--mode must be one of ${MODES.join("|")}, got "${mode}"`);

const cases = readdirSync(FIXTURES, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((name) => !args.case || args.case.some((c) => name.includes(c)))
  .sort();
if (cases.length === 0) fatal(`no fixture matches --case ${args.case?.join(",")}`);

console.log(`us-json-gate cases — mode: ${mode}${args.mode ? " (--mode override)" : " (from .claude/settings.json)"}\n`);

const results = [];
try {
  for (const name of cases) {
    const r = runCase(name);
    results.push(r);
    printRow(r);
  }
} finally {
  // Remove the transcript folder only when empty — another mode's run may still be using it.
  if (!args.keep && existsSync(TRANSCRIPTS) && readdirSync(TRANSCRIPTS).length === 0) rmSync(TRANSCRIPTS, { recursive: true, force: true });
}

printSummary(results);
if (args.json) writeFileSync(resolve(args.json), JSON.stringify({ mode, results }, null, 2) + "\n");
process.exit(results.some((r) => r.result === "MISMATCH") ? 1 : 0);

// ── one case ──────────────────────────────────────────────────────────────────

function runCase(name) {
  const dir = join(FIXTURES, name);
  const spec = readJson(join(dir, "case.json"));
  const expected = spec.expect?.[mode];
  if (!expected) return { name, result: "skipped", note: spec.skip_reason?.[mode] ?? "no expectation for this mode" };

  const runId = `gate-test-${mode}-${name}`; // mode in the name: runs of different modes can go in parallel
  const runDir = join(ARTIFACTS, runId);
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  const hasUs = copyIfExists(join(dir, "us.json"), join(runDir, "us.json"));
  const hasSource = copyIfExists(join(dir, "tracker-source.json"), join(runDir, "tracker-source.json"));
  const fixedPath = join(dir, "us.fixed.json");

  const usId = spec.us_id ?? "114";
  const transcriptPath = writeTranscript(runId, usId, { hasUs, hasSource });
  const agentId = `harness-${name}-${mode}-${Date.now()}`;
  const lastMessage = spec.last_message ?? `run_id=${runId} us_id=${usId} title="fixture" scenario_count=0`;

  const steps = [];
  let fixApplied = false;
  try {
    for (let i = 0; i < expected.length; i++) {
      if (steps.at(-1)?.outcome === "BLOCK" && !fixApplied && existsSync(fixedPath)) {
        copyFileSync(fixedPath, join(runDir, "us.json")); // the "planner" fixes us.json in place
        fixApplied = true;
      }
      const step = callGate({ runDir, transcriptPath, agentId, stopHookActive: i > 0, lastMessage, env: spec.env });
      steps.push(step);
      if (ALLOWED_STOPS.has(step.outcome)) break;
    }
  } finally {
    rmSync(join(STATE_DIR, `us-json-gate-${agentId}.json`), { force: true });
    if (!args.keep) {
      rmSync(runDir, { recursive: true, force: true });
      rmSync(transcriptPath, { force: true });
    }
  }

  const actual = steps.map((s) => s.outcome);
  const sameSequence = actual.join(" ") === expected.join(" ");
  const assertErrors = sameSequence ? checkAsserts(spec, steps) : [];
  const lastStatus = [...steps].reverse().find((s) => s.status)?.status ?? null;
  return {
    name,
    expected,
    actual,
    result: sameSequence && assertErrors.length === 0 ? "ok" : "MISMATCH",
    kind: sameSequence ? (assertErrors.length ? "assertion failed" : null) : mismatchKind(expected, actual),
    assert_errors: assertErrors,
    blind_spot: (spec.blind_spot ?? []).includes(mode),
    fix_applied: fixApplied,
    retries: lastStatus?.retries ?? null,
    checked_by: lastStatus?.checked_by ?? null,
    ms: steps.map((s) => s.ms),
    steps: steps.map(({ outcome, ms, status, reason }) => ({ outcome, ms, notes: status?.notes ?? [], reason })),
  };
}

// ── one gate call (one SubagentStop) ─────────────────────────────────────────

function callGate({ runDir, transcriptPath, agentId, stopHookActive, lastMessage, env }) {
  const statusPath = join(runDir, "us.validation.json");
  const before = readOrNull(statusPath);
  const input = {
    session_id: "harness",
    transcript_path: transcriptPath,
    cwd: ROOT,
    permission_mode: "default",
    hook_event_name: "SubagentStop",
    stop_hook_active: stopHookActive,
    agent_id: agentId,
    agent_type: "story-planner",
    agent_transcript_path: transcriptPath,
    last_assistant_message: lastMessage,
  };
  const childEnv = { ...process.env, CLAUDE_PROJECT_DIR: ROOT, ...(env ?? {}) };
  delete childEnv.US_GATE_CHILD; // the gate is a no-op when this is set

  const t0 = Date.now();
  const run = spawnSync(process.execPath, [GATE, "--mode", mode], {
    cwd: ROOT,
    input: JSON.stringify(input),
    env: childEnv,
    encoding: "utf8",
    timeout: 300_000,
    windowsHide: true,
  });
  const ms = Date.now() - t0;

  const out = parseJson((run.stdout ?? "").trim().split(/\r?\n/).pop()) ?? {};
  const after = readOrNull(statusPath);
  const status = parseJson(after);
  const reason = out.reason ?? out.systemMessage ?? "";

  let outcome;
  if (run.error || run.status !== 0 || String(out.systemMessage ?? "").startsWith("us-json-gate crashed")) outcome = "GATE_ERROR";
  else if (out.decision === "block") outcome = status?.status === "FAILED" ? "FINAL" : "BLOCK";
  else if (after === before) outcome = "STOP";
  else if (status?.status === "PASSED") outcome = "PASS";
  else if (status?.status === "UNVERIFIED") outcome = "UNVERIFIED";
  else if (status?.status === "FAILED" && status.blocked) outcome = "BLOCKED";
  else outcome = `UNKNOWN(${status?.status ?? "no status"})`;

  return { outcome, ms, status, reason: outcome === "GATE_ERROR" ? reason || run.stderr || String(run.error) : reason };
}

/** A minimal subagent transcript: the skill arguments plus the tool calls a real planner makes. */
function writeTranscript(runId, usId, { hasUs, hasSource }) {
  mkdirSync(TRANSCRIPTS, { recursive: true });
  const tools = [];
  if (hasSource || !hasUs) {
    tools.push({
      type: "tool_use",
      id: "toolu_get",
      name: "Bash",
      input: { command: `bash .claude/skills/operations-with-issue-tracker/scripts/get.sh --id ${usId} > .workflow-artifacts/${runId}/tracker-source.json` },
    });
  }
  if (hasUs) {
    tools.push({ type: "tool_use", id: "toolu_write", name: "Write", input: { file_path: join(ARTIFACTS, runId, "us.json"), content: "…" } });
  }
  const lines = [
    { type: "user", message: { role: "user", content: `Arguments: --run-id ${runId} --us-id ${usId}` } },
    { type: "assistant", message: { role: "assistant", content: tools } },
  ];
  const path = join(TRANSCRIPTS, `${runId}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

// ── checks ───────────────────────────────────────────────────────────────────

function checkAsserts(spec, steps) {
  const a = { ...(spec.assert?.["*"] ?? {}), ...(spec.assert?.[mode] ?? {}) };
  const lastStatus = [...steps].reverse().find((s) => s.status)?.status ?? {};
  const firstNotes = steps.find((s) => s.status?.notes?.length)?.status.notes ?? [];
  const errors = [];
  if ("retries" in a && lastStatus.retries !== a.retries) errors.push(`retries is ${lastStatus.retries}, expected ${a.retries}`);
  if (a.checked_by_includes && !String(lastStatus.checked_by ?? "").includes(a.checked_by_includes)) {
    errors.push(`checked_by "${lastStatus.checked_by}" does not include "${a.checked_by_includes}"`);
  }
  if ("notes_count" in a && firstNotes.length !== a.notes_count) errors.push(`first feedback has ${firstNotes.length} notes, expected ${a.notes_count}`);
  if (a.notes_match && !new RegExp(a.notes_match, "i").test(firstNotes.join("\n"))) errors.push(`first feedback notes do not match /${a.notes_match}/i`);
  if (a.reason_includes && !steps.some((s) => s.reason.includes(a.reason_includes))) errors.push(`no gate output contains "${a.reason_includes}"`);
  return errors;
}

function mismatchKind(expected, actual) {
  const defective = expected[0] !== "PASS";
  if (defective && actual[0] === "PASS") return "false pass — the validator missed a labelled defect";
  if (!defective && actual[0] === "BLOCK") return "false fail — the validator flagged a correct file";
  if (expected[0] === "BLOCK" && actual[0] === "BLOCK" && expected[1] === "PASS" && actual[1] === "BLOCK") {
    return "fix not accepted — the corrected us.json was flagged again";
  }
  return "different outcome";
}

// ── output ───────────────────────────────────────────────────────────────────

function printRow(r) {
  if (r.result === "skipped") {
    console.log(`  -   ${r.name.padEnd(28)} skipped (${r.note})`);
    return;
  }
  const mark = r.result === "ok" ? "ok " : "XX ";
  const seq = r.actual.join("→");
  const time = r.ms.map(fmtMs).join(" + ");
  const blind = r.blind_spot ? "  [expected blind spot]" : "";
  console.log(`  ${mark} ${r.name.padEnd(28)} ${seq.padEnd(34)} retries=${String(r.retries).padEnd(4)} ${time}${blind}`);
  if (r.result !== "ok") {
    console.log(`        expected ${r.expected.join("→")} — ${r.kind}`);
    for (const e of r.assert_errors) console.log(`        assert: ${e}`);
  }
  if (r.result !== "ok" || args.verbose) {
    console.log(`        checked_by: ${r.checked_by}`);
    r.steps.forEach((s, i) => {
      console.log(`        call ${i + 1}: ${s.outcome} (${fmtMs(s.ms)})`);
      for (const n of s.notes) if (s.outcome === "BLOCK" || s.outcome === "FINAL" || s.outcome === "BLOCKED") console.log(`          - ${n}`);
      if (s.outcome === "GATE_ERROR" || s.outcome === "UNVERIFIED") console.log(`          ${s.reason}`);
    });
  }
}

function printSummary(rs) {
  const ran = rs.filter((r) => r.result !== "skipped");
  const bad = ran.filter((r) => r.result === "MISMATCH");
  const blind = ran.filter((r) => r.blind_spot);
  const calls = ran.reduce((n, r) => n + r.ms.length, 0);
  const totalMs = ran.reduce((n, r) => n + r.ms.reduce((a, b) => a + b, 0), 0);
  console.log(`\n${ran.length - bad.length}/${ran.length} cases as expected, ${rs.length - ran.length} skipped — ${calls} gate calls, ${fmtMs(totalMs)} total`);
  if (blind.length) console.log(`expected blind spots of "${mode}" mode (defect present, validator passes it): ${blind.map((r) => r.name).join(", ")}`);
  if (bad.length) console.log(`MISMATCH: ${bad.map((r) => `${r.name} (${r.kind})`).join("; ")}`);
}

function fmtMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function settingsMode() {
  const settings = readJson(join(ROOT, ".claude", "settings.json"));
  for (const group of settings.hooks?.SubagentStop ?? []) {
    for (const hook of group.hooks ?? []) {
      const m = /us-json-gate\.mjs.*--mode[=\s]+(\w+)/.exec(hook.command ?? "");
      if (m) return m[1];
    }
  }
  return "script"; // the gate's own default
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split("=", 2);
    const value = () => inline ?? argv[++i];
    if (flag === "--mode") out.mode = String(value()).toLowerCase();
    else if (flag === "--case") out.case = String(value()).split(",").filter(Boolean);
    else if (flag === "--json") out.json = value();
    else if (flag === "--keep") out.keep = true;
    else if (flag === "--verbose" || flag === "-v") out.verbose = true;
    else fatal(`unknown argument "${argv[i]}"`);
  }
  return out;
}

function copyIfExists(from, to) {
  if (!existsSync(from)) return false;
  copyFileSync(from, to);
  return true;
}

function readJson(path) {
  const parsed = parseJson(readOrNull(path));
  if (parsed === null) fatal(`cannot read JSON from ${path}`);
  return parsed;
}

function readOrNull(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

function fatal(msg) {
  console.error(msg);
  process.exit(2);
}
