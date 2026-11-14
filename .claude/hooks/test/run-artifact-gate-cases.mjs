// Offline test cases for the gt-test-ideation feedback loop (.claude/hooks/artifact-gate.mjs → test-ideas.json).
//
//   node .claude/hooks/test/run-artifact-gate-cases.mjs [--trigger write|stop] [--case <substr>[,<substr>]]
//                                                       [--verbose] [--keep] [--json <out.json>]
//   npm run test:artifact-gate                       # trigger from .claude/hooks/artifact-gate.json
//   npm run test:artifact-gate -- --trigger stop     # one-off override (via a temporary config copy)
//
// Trigger: read from artifact-gate.json ("trigger" of the test-ideas.json entry), so by default the runner tests the
// option the live hook uses. --trigger overrides it: the runner writes a copy of the config with the other trigger
// and points the gate at it with ARTIFACT_GATE_CONFIG — the real config is never edited.
//
// No skill runs here — the runner plays the agent. fixtures/test-ideas/_base/ holds a valid run folder (us.json,
// scenarios.md, test-ideas.json); each case folder holds only what differs, plus case.json:
//   description, expect.{write,stop} (outcome sequence), writes (files written in order), remove, extra_files,
//   location ("outside" = not a run folder), last_message (stop), skip_reason, blind_spot, assert.{*,write,stop}
// A test-ideas.fixed.json is the corrected file the "agent" writes after a BLOCK (closes the loop).
//
//   write → each written file = one PostToolUse(Write) call.         stop → all writes, then Stop calls (exit 2 = block)
// Outcomes:
//   PASS         status PASSED                      BLOCK    feedback, status RETRYING
//   FINAL        feedback, status FAILED (retries used up: "reply with the failure report")
//   SILENT       write: no feedback, status FAILED  STOP     stop: no feedback, status FAILED — the stop is allowed
//   BLOCKED      stop allowed, status FAILED + blocked (the agent declared "BLOCKED: <reason>")
//   SKIPPED      stop: run folder past this stage    NO_ARTIFACT  stop: no test-ideas.json written this turn
//   IGNORED      write: not a run-folder artifact, no status written
// Exit code 1 on any mismatch.

import { writeFileSync, mkdirSync, rmSync, existsSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  HERE, ROOT, ARTIFACTS, TRANSCRIPTS, STATE_DIR, parseArgs, listCases, checkAsserts, mismatchKind, printRow, printSummary,
  removeTranscriptDirIfEmpty, lastJsonLine, readJson, readOrNull, parseJson, fatal,
} from "./harness-lib.mjs";

const FIXTURES = join(HERE, "fixtures", "test-ideas");
const BASE = join(FIXTURES, "_base");
const GATE = join(ROOT, ".claude", "hooks", "artifact-gate.mjs");
const CONFIG = join(ROOT, ".claude", "hooks", "artifact-gate.json");
const ARTIFACT = "test-ideas.json";
const TRIGGERS = ["write", "stop"];
const STOP_ENDS = new Set(["PASS", "STOP", "BLOCKED", "SKIPPED", "NO_ARTIFACT", "IGNORED", "GATE_ERROR"]);

const args = parseArgs(process.argv.slice(2), { "--trigger": "trigger" });
const config = readJson(CONFIG);
const configured = config[ARTIFACT]?.trigger;
const trigger = (args.trigger ?? configured ?? "").toLowerCase();
if (!TRIGGERS.includes(trigger)) fatal(`--trigger must be one of ${TRIGGERS.join("|")}, got "${trigger}"`);

// The gate reads this copy: same entry, trigger forced to the one under test.
mkdirSync(TRANSCRIPTS, { recursive: true });
const configCopy = join(TRANSCRIPTS, `artifact-gate.${trigger}.json`);
writeFileSync(configCopy, JSON.stringify({ ...config, [ARTIFACT]: { ...config[ARTIFACT], trigger } }, null, 2) + "\n");

const cases = listCases(FIXTURES, args.case);
console.log(`artifact-gate cases (test-ideas.json) — trigger: ${trigger}${args.trigger ? " (--trigger override)" : " (from .claude/hooks/artifact-gate.json)"}\n`);

const results = [];
try {
  for (const name of cases) {
    const r = runCase(name);
    results.push(r);
    printRow(r, { verbose: args.verbose });
  }
} finally {
  rmSync(configCopy, { force: true });
  if (!args.keep) removeTranscriptDirIfEmpty();
}

printSummary(results, `the deterministic validator (trigger ${trigger})`);
if (args.json) writeFileSync(resolve(args.json), JSON.stringify({ trigger, results }, null, 2) + "\n");
process.exit(results.some((r) => r.result === "MISMATCH") ? 1 : 0);

// ── one case ──────────────────────────────────────────────────────────────────

function runCase(name) {
  const dir = join(FIXTURES, name);
  const spec = readJson(join(dir, "case.json"));
  const expected = spec.expect?.[trigger];
  if (!expected) return { name, result: "skipped", note: spec.skip_reason?.[trigger] ?? "no expectation for this trigger" };

  const runId = `gate-test-ideas-${trigger}-${name}`;
  // "outside": a dot-folder is not a run folder (.workflow-artifacts/.hook-test/<id>/), so the gate must not act.
  const runDir = spec.location === "outside" ? join(TRANSCRIPTS, runId) : join(ARTIFACTS, runId);
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  for (const f of ["us.json", "scenarios.md"]) if (!(spec.remove ?? []).includes(f)) copyFileSync(join(BASE, f), join(runDir, f));
  for (const [f, content] of Object.entries(spec.extra_files ?? {})) writeFileSync(join(runDir, f), JSON.stringify(content, null, 2) + "\n");

  const target = join(runDir, ARTIFACT);
  const statusPath = join(runDir, "test-ideas.validation.json");
  const sessionId = `harness-${name}-${trigger}-${Date.now()}`;
  const transcriptPath = join(TRANSCRIPTS, `${runId}.jsonl`);
  const written = []; // tool calls the "agent" made, for the stop trigger's transcript
  const write = (file) => {
    copyFileSync(fixtureFile(dir, file), target);
    written.push(file);
  };
  const hasFixed = existsSync(join(dir, "test-ideas.fixed.json"));

  const steps = [];
  let fixApplied = false;
  try {
    if (trigger === "write") {
      let current = "test-ideas.json";
      for (let i = 0; i < expected.length; i++) {
        if (spec.writes) {
          if (i >= spec.writes.length) break;
          current = spec.writes[i];
        } else if (steps.at(-1)?.outcome === "BLOCK" && hasFixed && !fixApplied) {
          current = "test-ideas.fixed.json"; // the "agent" fixes the file in place
          fixApplied = true;
        }
        write(current);
        const step = callGate({ sessionId, transcriptPath, statusPath, input: writeInput(target) });
        step.label = `writes ${current}`;
        steps.push(step);
        if (!spec.writes && (step.outcome === "PASS" || step.outcome === "IGNORED" || step.outcome === "GATE_ERROR")) break;
      }
    } else {
      for (const f of spec.writes ?? ["test-ideas.json"]) write(f);
      for (let i = 0; i < expected.length; i++) {
        let label = i === 0 ? `wrote ${written.join(", ")}; stops` : "stops again";
        if (i > 0 && ["BLOCK", "FINAL"].includes(steps.at(-1).outcome) && hasFixed && !fixApplied) {
          write("test-ideas.fixed.json");
          fixApplied = true;
          label = "writes test-ideas.fixed.json; stops again";
        }
        writeStopTranscript(transcriptPath, target, written.length);
        const step = callGate({ sessionId, transcriptPath, statusPath, input: stopInput(i > 0, spec.last_message) });
        step.label = label;
        steps.push(step);
        if (STOP_ENDS.has(step.outcome)) break;
      }
    }
  } finally {
    rmSync(join(STATE_DIR, `artifact-gate-${runId}-test-ideas.json`), { force: true });
    if (!args.keep) {
      rmSync(runDir, { recursive: true, force: true });
      rmSync(transcriptPath, { force: true });
    }
  }

  const actual = steps.map((s) => s.outcome);
  const sameSequence = actual.join(" ") === expected.join(" ");
  const asserts = { ...(spec.assert?.["*"] ?? {}), ...(spec.assert?.[trigger] ?? {}) };
  const assertErrors = sameSequence ? checkAsserts(asserts, steps) : [];
  const lastStatus = [...steps].reverse().find((s) => s.status)?.status ?? null;
  return {
    name,
    expected,
    actual,
    result: sameSequence && assertErrors.length === 0 ? "ok" : "MISMATCH",
    kind: sameSequence ? (assertErrors.length ? "assertion failed" : null) : mismatchKind(expected, actual),
    assert_errors: assertErrors,
    blind_spot: (spec.blind_spot ?? []).includes(trigger),
    fix_applied: fixApplied,
    retries: lastStatus?.retries ?? null,
    ms: steps.map((s) => s.ms),
    steps: steps.map(({ outcome, ms, status, reason, label }) => ({ outcome, ms, label, notes: status?.notes ?? [], reason })),
  };
}

// ── one gate call ────────────────────────────────────────────────────────────

function writeInput(target) {
  return {
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: target, content: "…" },
    tool_response: { type: "update", filePath: target },
  };
}

function stopInput(stopHookActive, lastMessage) {
  return {
    hook_event_name: "Stop",
    stop_hook_active: stopHookActive,
    last_assistant_message: lastMessage ?? "test-ideas.json and test-ideas.md written.",
  };
}

function callGate({ sessionId, transcriptPath, statusPath, input }) {
  const before = readOrNull(statusPath);
  const full = { session_id: sessionId, transcript_path: transcriptPath, cwd: ROOT, permission_mode: "default", ...input };
  const argv = [GATE, "--trigger", trigger, ...(trigger === "stop" ? ["--artifact", ARTIFACT] : [])];
  const env = { ...process.env, CLAUDE_PROJECT_DIR: ROOT, ARTIFACT_GATE_CONFIG: configCopy };

  const t0 = Date.now();
  const run = spawnSync(process.execPath, argv, { cwd: ROOT, input: JSON.stringify(full), env, encoding: "utf8", timeout: 60_000, windowsHide: true });
  const ms = Date.now() - t0;

  const out = lastJsonLine(run.stdout);
  const after = readOrNull(statusPath);
  const status = parseJson(after);
  const blocked = out.decision === "block" || run.status === 2;
  const reason = String(out.reason ?? (run.status === 2 ? run.stderr : "") ?? "") || String(out.systemMessage ?? "");

  let outcome;
  if (run.error || ![0, 2].includes(run.status) || String(out.systemMessage ?? "").startsWith("artifact-gate crashed")) outcome = "GATE_ERROR";
  else if (blocked) outcome = status?.status === "FAILED" ? "FINAL" : "BLOCK";
  else if (/nothing validated/.test(String(out.systemMessage ?? ""))) outcome = "NO_ARTIFACT";
  else if (after === before) outcome = trigger === "stop" ? "SKIPPED" : "IGNORED";
  else if (status?.status === "PASSED") outcome = "PASS";
  else if (status?.status === "FAILED" && status.blocked) outcome = "BLOCKED";
  else if (status?.status === "FAILED") outcome = trigger === "stop" ? "STOP" : "SILENT";
  else outcome = `UNKNOWN(${status?.status ?? "no status"})`;

  return {
    outcome,
    ms,
    status: after === before ? null : status,
    feedback: blocked,
    reason: outcome === "GATE_ERROR" ? reason || run.stderr || String(run.error) : reason,
  };
}

/** Main-agent transcript: the skill invocation, then one Write per file written so far (all to the same path). */
function writeStopTranscript(path, target, writes) {
  const lines = [
    { type: "user", message: { role: "user", content: "Generate test ideas for the planned scenarios" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_skill", name: "Skill", input: { skill: "gt-test-ideation" } }] } },
  ];
  for (let k = 0; k < writes; k++) {
    lines.push({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_write_${k}`, name: "Write", input: { file_path: target, content: "…" } }] },
    });
  }
  mkdirSync(TRANSCRIPTS, { recursive: true });
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

function fixtureFile(dir, file) {
  const own = join(dir, file);
  if (existsSync(own)) return own;
  const base = join(BASE, file);
  if (existsSync(base)) return base;
  fatal(`fixture file ${file} not found in ${dir} or _base`);
}
