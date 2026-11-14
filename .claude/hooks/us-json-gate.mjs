// SubagentStop feedback-loop gate for gt-story-planner → us.json.
//
// Registered in .claude/settings.json under SubagentStop with matcher "^story-planner$"
// (gt-story-planner runs as that subagent via `context: fork`).
//
//   node .claude/hooks/us-json-gate.mjs --mode subagent|script|llm   (hook input JSON on stdin)
//
// Exactly one validator is active — the --mode in .claude/settings.json decides which:
//   subagent → case 1: the .claude/agents/us-json-reviewer.md agent, run as-is
//              (own tools + multi-turn; reads us.json itself)       lib/review-us-json-subagent.mjs
//   script   → case 2: deterministic contract check, no LLM          lib/validate-us-json.mjs   [default]
//   llm      → case 3: one LLM call, no tools, content pasted in     lib/review-us-json-llm.mjs
//
// Pre-check → a missing run folder / us.json is reported by the gate itself, before any validator
//        runs (checked_by: "gate pre-check (...)") — no LLM/subagent call is made for it.
// Fail → {"decision":"block","reason":...} keeps the planner subagent running with the feedback
//        as its next instruction, at most MAX_RETRIES times per subagent run (agent_id).
// Blocker → if the planner's final message has a "BLOCKED: <reason>" line (it cannot produce a valid
//        us.json: empty story, denied tool), the check's failure is recorded as FAILED at once and
//        the stop is allowed — no retries burned on a condition that will never resolve.
//        Test cases for all of this: .claude/hooks/test/run-us-json-gate-cases.mjs
// Then → one last block tells the planner to stop fixing and end with a
//        "US.JSON VALIDATION FAILED ..." report (that final message is what the caller receives);
//        us.validation.json gets status FAILED (flow-1a aborts Phase 1 on it). The stop after
//        that report is always allowed, so the loop is bounded: at most MAX_RETRIES + 1 blocks.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { validateUsJsonFile } from "./lib/validate-us-json.mjs";
import { reviewWithSubagent } from "./lib/review-us-json-subagent.mjs";
import { reviewWithLlm } from "./lib/review-us-json-llm.mjs";

const MAX_RETRIES = 3;
const VALIDATORS = {
  subagent: "subagent (us-json-reviewer.md)",
  script: "script (validate-us-json.mjs)",
  llm: "llm call (single, no tools)",
};
const MODES = Object.keys(VALIDATORS);

let projectDir = process.cwd();
let stateDir = join(projectDir, ".workflow-artifacts", ".hook-state");
let logContext = {};

async function main() {
  const mode = parseMode(process.argv.slice(2));
  const input = parseJson(readStdin()) ?? {};

  projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  stateDir = join(projectDir, ".workflow-artifacts", ".hook-state");
  const agentId = String(input.agent_id || input.session_id || "unknown").replace(/[^\w.-]/g, "_");
  logContext = { agent_type: input.agent_type ?? null, agent_id: agentId, mode, stop_hook_active: !!input.stop_hook_active };

  const statePath = join(stateDir, `us-json-gate-${agentId}.json`);
  const state = parseJson(readOrNull(statePath)) ?? { attempts: 0 };

  // The planner was already told to give up and report — let that final stop through.
  if (state.reported) {
    log({ result: "STOP_AFTER_FAILURE_REPORT", retries: state.attempts });
    return;
  }

  const transcript = readTranscript(input.agent_transcript_path || input.transcript_path);
  const runDir = locateRunDir(transcript);
  const usPath = runDir ? join(runDir, "us.json") : null;
  const usRel = usPath ? toRel(usPath) : null;

  // ── Check (exactly one validator, chosen by --mode) ───────────────────────
  // A missing run folder / us.json is caught by the gate itself before any validator runs —
  // checked_by says so, so a FAILED record never claims an LLM/subagent review that did not happen.
  let checkedBy = VALIDATORS[mode];
  let notes = [];
  let reviewerError = null;

  if (!usPath) {
    checkedBy = "gate pre-check (no run folder)";
    notes = ["us.json: no run folder found → write .workflow-artifacts/<run_id>/us.json (the run_id you were given) before finishing"];
  } else if (!existsSync(usPath)) {
    checkedBy = "gate pre-check (us.json missing)";
    notes = [`us.json: not found at ${usRel} → write it there before finishing`];
  } else if (mode === "script") {
    notes = validateUsJsonFile(usPath).errors;
  } else {
    const args = { projectDir, usPath: usRel };
    const review = mode === "subagent" ? await reviewWithSubagent(args) : await reviewWithLlm(args);
    if ("error" in review) reviewerError = review.error;
    else if (review.verdict === "FAIL") notes = review.notes.length ? review.notes : ["reviewer returned FAIL without notes"];
  }

  // ── Decide ────────────────────────────────────────────────────────────────
  const checkedAt = new Date().toISOString();

  if (reviewerError && notes.length === 0) {
    writeValidation(runDir, { status: "UNVERIFIED", retries: state.attempts, mode, checked_by: checkedBy, reviewer_error: reviewerError, checked_at: checkedAt });
    log({ us_path: usRel, result: "UNVERIFIED", retries: state.attempts, reviewer_error: reviewerError });
    emit({ systemMessage: `us.json reviewer could not run (stop allowed, not counted as a retry): ${reviewerError}` });
    return;
  }

  if (notes.length === 0) {
    writeValidation(runDir, { status: "PASSED", retries: state.attempts, mode, checked_by: checkedBy, checked_at: checkedAt });
    log({ us_path: usRel, result: "PASSED", retries: state.attempts });
    return;
  }

  // The planner declared it cannot produce a valid us.json ("BLOCKED: <reason>" line in its final
  // message — empty story, denied tool, ...). Blocking again would only burn retries on a condition
  // that will never resolve, so record FAILED now and let the stop through. Declaring a blocker can
  // never yield a pass: the outcome is always FAILED, which flow-1a aborts on.
  const blocker = declaredBlocker(input, transcript);
  if (blocker) {
    state.reported = true;
    writeJson(statePath, { ...state, us_path: usRel, blocked: blocker, updated_at: checkedAt });
    writeValidation(runDir, { status: "FAILED", retries: state.attempts, mode, checked_by: checkedBy, blocked: blocker, notes, checked_at: checkedAt });
    log({ us_path: usRel, result: "BLOCKED", retries: state.attempts, blocked: blocker, notes });
    emit({ systemMessage: `story-planner declared a blocker — us.json marked FAILED without retrying: ${blocker}` });
    return;
  }

  if (state.attempts < MAX_RETRIES) {
    state.attempts += 1;
    writeJson(statePath, { ...state, us_path: usRel, updated_at: checkedAt });
    writeValidation(runDir, { status: "RETRYING", retries: state.attempts, mode, checked_by: checkedBy, notes, checked_at: checkedAt });
    log({ us_path: usRel, result: "BLOCK", retries: state.attempts, notes });
    emit({
      decision: "block",
      reason: [
        `us.json validation FAILED (retry ${state.attempts}/${MAX_RETRIES}) — checked by: ${checkedBy}`,
        usRel ? `File: ${usRel}` : null,
        ...notes.map((n) => `- ${n}`),
        ``,
        `Fix us.json in place (same run_id, same path) so every point above is resolved, then finish again.`,
        `If you change "ac", update scenarios.md so it still covers every AC.`,
        `If something outside your control blocks the fix (e.g. a denied tool, or the story has no usable content), stop trying: do not write a placeholder us.json — end your final message with a line starting "BLOCKED: <reason>".`,
      ]
        .filter((l) => l !== null)
        .join("\n"),
    });
    return;
  }

  // Retries used up: one last block so the planner's final message (what the caller receives)
  // reports the failure. `reported` makes the next stop pass unconditionally.
  state.reported = true;
  writeJson(statePath, { ...state, us_path: usRel, updated_at: checkedAt });
  const validationRel = runDir ? toRel(join(runDir, "us.validation.json")) : null;
  writeValidation(runDir, { status: "FAILED", retries: state.attempts, mode, checked_by: checkedBy, notes, checked_at: checkedAt });
  log({ us_path: usRel, result: "FAILED", retries: state.attempts, notes });
  emit({
    decision: "block",
    reason: [
      `us.json validation FAILED — all ${MAX_RETRIES} retries are used up (checked by: ${checkedBy}).`,
      `Stop fixing and do not call any more tools. Reply now with your final message, starting with this line:`,
      `US.JSON VALIDATION FAILED after ${MAX_RETRIES} retries — ${usRel ?? "us.json not written"}`,
      `followed by these unresolved problems:`,
      ...notes.map((n) => `- ${n}`),
      validationRel ? `Details: ${validationRel}` : null,
    ]
      .filter((l) => l !== null)
      .join("\n"),
    systemMessage: `us.json still invalid after ${MAX_RETRIES} retries${validationRel ? ` — see ${validationRel}` : ""}`,
  });
}

// ── run folder discovery ────────────────────────────────────────────────────

// .workflow-artifacts/<dir>/… in raw or JSON-escaped text; skips globs, unexpanded variables
// like ${run_id} / {run_id} / <run_id>, and dot-folders such as .hook-state.
const RUN_DIR_RE =
  /\.workflow-artifacts[\\/]+([^.\\/"'`\s*?{}$<>|][^\\/"'`\s*?{}$<>|]*)(?=[\\/"'`\s;&)]|$)(?:[\\/]+([^\\/"'`\s*?{}$<>|]*))?/g;

/**
 * The planner's own run folder, from its transcript — never a "newest folder" guess, so the gate
 * can't end up checking another run's us.json. Priority (last match within the first tier that has one):
 *   1. us.json targeted by Write/Edit (even if the write was denied)
 *   2. --run-id passed in the skill arguments
 *   3. us.json mentioned in any tool call (e.g. a Bash redirect)
 *   4. any file under .workflow-artifacts/<dir>/ in any tool call (e.g. tracker-source.json)
 */
function locateRunDir(transcript) {
  const tiers = [[], [], [], []];
  for (const block of contentBlocks(transcript, "tool_use")) {
    const text = JSON.stringify(block.input ?? {});
    const isWrite = ["Write", "Edit", "MultiEdit"].includes(block.name);
    for (const [, dir, file] of text.matchAll(RUN_DIR_RE)) {
      if (file === "us.json") tiers[isWrite ? 0 : 2].push(dir);
      tiers[3].push(dir);
    }
  }
  for (const e of transcript) {
    if (e?.type !== "user") continue;
    const text = typeof e.message?.content === "string" ? e.message.content : JSON.stringify(e.message?.content ?? "");
    for (const [, id] of text.matchAll(/--run-id[=\s]+([\w.-]+)/g)) tiers[1].push(id);
  }
  const dir = tiers.find((t) => t.length)?.at(-1);
  return dir ? join(projectDir, ".workflow-artifacts", dir) : null;
}

// ── declared blocker ────────────────────────────────────────────────────────

/**
 * The "BLOCKED: <reason>" line from the planner's final message, or null. Reads the hook input's
 * last_assistant_message (the docs' recommended source — the transcript file may lag at stop time),
 * falling back to the last assistant text in the transcript. Tolerates markdown such as **BLOCKED:**.
 */
function declaredBlocker(input, transcript) {
  const text = typeof input.last_assistant_message === "string" ? input.last_assistant_message : lastAssistantText(transcript);
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.replace(/^[\s>*_`#-]+/, "").replace(/[*_`]+/g, "").trim();
    if (/^BLOCKED:\s*\S/i.test(line)) return line.slice(0, 500);
  }
  return null;
}

function lastAssistantText(transcript) {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const e = transcript[i];
    if (e?.type !== "assistant") continue;
    const content = e.message?.content;
    if (typeof content === "string") return content;
    const text = Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "";
    if (text) return text;
  }
  return "";
}

// ── transcript helpers ──────────────────────────────────────────────────────

function readTranscript(path) {
  if (!path) return [];
  const p = path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
  const raw = readOrNull(p);
  if (!raw) return [];
  return raw.split(/\r?\n/).map(parseJson).filter(Boolean);
}

function contentBlocks(entries, type) {
  const out = [];
  for (const e of entries) {
    const content = e?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) if (b?.type === type) out.push(b);
  }
  return out;
}

// ── io helpers ──────────────────────────────────────────────────────────────

function parseMode(args) {
  const i = args.indexOf("--mode");
  const raw = i >= 0 ? args[i + 1] : (args.find((a) => a.startsWith("--mode="))?.split("=")[1] ?? "script");
  const mode = String(raw).toLowerCase();
  if (!MODES.includes(mode)) throw new Error(`--mode must be one of ${MODES.join("|")}, got "${mode}"`);
  return mode;
}

function writeValidation(runDir, record) {
  if (!runDir) return;
  writeJson(join(runDir, "us.validation.json"), { max_retries: MAX_RETRIES, ...record });
}

function log(fields) {
  safeLog(fields);
}

function safeLog(fields) {
  try {
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(join(stateDir, "us-json-gate.log"), JSON.stringify({ ts: new Date().toISOString(), ...logContext, ...fields }) + "\n");
  } catch {
    /* logging must never break the gate */
  }
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
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
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function toRel(p) {
  const r = isAbsolute(p) ? relative(projectDir, p) : p;
  return r.split("\\").join("/");
}

// ── entry (last, so every module-level const above is initialised) ──────────

// Recursion guard: the reviewer session must never run this gate.
if (!process.env.US_GATE_CHILD) {
  main().catch((e) => {
    emit({ systemMessage: `us-json-gate crashed (stop allowed): ${e?.message ?? e}` });
    safeLog({ result: "GATE_ERROR", error: String(e?.stack ?? e) });
    process.exit(0);
  });
}
