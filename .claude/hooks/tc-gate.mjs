// Feedback-loop gate for gt-test-case-generator (flow-1a Phase 3) → tc-N.json + tc-steps-N.md.
// Same loop as artifact-gate.mjs, but the check is ONE direct LLM call (lib/review-tc-llm.mjs).
//
//   node .claude/hooks/tc-gate.mjs [--model sonnet]   (hook input JSON on stdin)
//
// Registered in the skill's own frontmatter (.claude/skills/gt-test-case-generator/SKILL.md) as a
// PostToolUse hook on Bash with `if: Bash(bash .claude/skills/gt-test-case-generator/scripts/*)`.
// The TC files are written by a bash script, not by Write/Edit, so the trigger is the script's Bash
// call. The script name is checked again here, so a stray call does nothing (no output, no log).
//
//   run folder ← --run-dir of the command (fallback: dirname of --ideas-file); simple `name=value`
//                assignments in the same command are expanded, anything else with `$` is unresolved
//   scope      ← generate-tc.sh --index N → [N]; batch-generate-tc.sh → every test-ideas.json index
//                (unresolvable --index, e.g. a shell loop → every index that has a tc-N.json)
//
// Reviewer: one SDK query, no tools, files pasted in; rules = the "## Acceptance criteria
// (LLM-reviewed)" section of the skill's SKILL.md. FAIL → {"decision":"block","reason":...} on stdout,
// shown to the agent next to the script's output. Reviewer could not run → UNVERIFIED, not a retry.
//
// Bounded loop per (session, run folder): up to MAX_RETRIES feedback blocks, then one last block asking
// for a "TC VALIDATION FAILED after N retries — <run_dir>" report, then no more feedback (later runs
// re-validate silently, so the status can still flip to PASSED).
// PostToolUse fires only when the script exits 0; a batch run with [FAIL] scenarios exits 1 → no review.
// Status: {run_dir}/tc.validation.json     State + log: .workflow-artifacts/.hook-state/

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname, relative, isAbsolute, resolve } from "node:path";
import { reviewTcWithLlm, DEFAULT_MODEL } from "./lib/review-tc-llm.mjs";

const MAX_RETRIES = 3;
const MAX_LISTED_NOTES = 20;
const SCRIPT_RE = /gt-test-case-generator[\\/]+scripts[\\/]+((?:batch-)?generate-tc\.sh)\b/;
const VALIDATOR = "lib/review-tc-llm.mjs";
const CHECKED_BY = `llm call (single, no tools) — ${VALIDATOR}`;

let projectDir = process.cwd();
let stateDir = join(projectDir, ".workflow-artifacts", ".hook-state");
let logContext = {};

async function main() {
  const model = parseModel(process.argv.slice(2));
  const input = parseJson(readStdin()) ?? {};

  // ── 1. Is this a generator script run ──────────────────────────────────────
  const command = String(input.tool_input?.command ?? "");
  const hit = SCRIPT_RE.exec(command);
  if (!hit) return; // unrelated Bash call: no output, no log
  const script = hit[1];
  const after = command.slice(hit.index); // args of the first generator call

  projectDir = resolve(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
  stateDir = join(projectDir, ".workflow-artifacts", ".hook-state");
  const sessionId = String(input.session_id || "unknown");
  logContext = { script, session_id: sessionId };

  // ── 2. Run folder + test-ideas.json ────────────────────────────────────────
  const vars = shellAssignments(command);
  const runDirArg = expand(getArg(after, "run-dir"), vars);
  const ideasArg = expand(getArg(after, "ideas-file"), vars);
  const runDir = [runDirArg, ideasArg && dirname(ideasArg)]
    .filter(Boolean)
    .map((p) => runDirOf(resolve(projectDir, p)))
    .find(Boolean);
  if (!runDir) {
    log({ result: "NO_RUN_DIR", run_dir_arg: runDirArg ?? null, ideas_file_arg: ideasArg ?? null });
    emit({ systemMessage: `tc-gate: could not resolve .workflow-artifacts/<run_id>/ from the ${script} command — output not reviewed` });
    return;
  }
  const runRel = toRel(runDir.dir);
  logContext.path = runRel;

  const ideasPath = ideasArg ? resolve(projectDir, ideasArg) : join(runDir.dir, "test-ideas.json");
  const ideas = parseJson(readOrNull(ideasPath));
  if (!Array.isArray(ideas)) {
    log({ result: "NO_IDEAS", ideas_path: toRel(ideasPath) });
    emit({ systemMessage: `tc-gate: ${toRel(ideasPath)} is missing or not a JSON array — output not reviewed` });
    return;
  }

  // ── 3. Scope ───────────────────────────────────────────────────────────────
  let indices;
  if (script === "batch-generate-tc.sh") {
    indices = ideas.map((_, i) => i);
  } else {
    const raw = expand(getArg(after, "index"), vars);
    const n = /^\d+$/.test(raw ?? "") ? Number(raw) : NaN;
    indices = n < ideas.length ? [n] : existingTcIndices(runDir.dir).filter((i) => i < ideas.length);
  }
  if (!indices.length) {
    log({ result: "NO_SCOPE" });
    return;
  }
  logContext.indices = compactRange(indices);

  // ── 4. Review (one LLM call) ───────────────────────────────────────────────
  const stdout = typeof input.tool_response === "string" ? input.tool_response : String(input.tool_response?.stdout ?? "");
  const review = await reviewTcWithLlm({ projectDir, runDir: runDir.dir, ideas, indices, command, stdout, model });
  const reviewerError = "error" in review ? review.error : null;
  const notes = reviewerError ? [] : review.verdict === "FAIL" ? (review.notes.length ? review.notes : ["reviewer returned FAIL without notes"]) : [];

  // ── 5. Retry state (per session + run folder) ──────────────────────────────
  const statePath = join(stateDir, `tc-gate-${safe(runDir.id)}.json`);
  let state = parseJson(readOrNull(statePath));
  if (!state || state.session_id !== sessionId) state = { attempts: 0, reported: false, session_id: sessionId };
  const saveState = () => writeJson(statePath, { ...state, path: runRel, updated_at: new Date().toISOString() });

  const validationPath = join(runDir.dir, "tc.validation.json");
  const record = (status, extra = {}) =>
    writeJson(validationPath, {
      status,
      retries: state.attempts,
      max_retries: MAX_RETRIES,
      trigger: "bash",
      script,
      checked_by: CHECKED_BY,
      model,
      path: runRel,
      indices,
      notes,
      ...extra,
      checked_at: new Date().toISOString(),
    });

  // ── 6. Decide ──────────────────────────────────────────────────────────────
  if (reviewerError) {
    record("UNVERIFIED", { reviewer_error: reviewerError });
    log({ result: "UNVERIFIED", retries: state.attempts, reviewer_error: reviewerError });
    emit({ systemMessage: `tc reviewer could not run (not counted as a retry): ${reviewerError}` });
    return;
  }

  if (notes.length === 0) {
    record("PASSED");
    log({ result: "PASSED", retries: state.attempts });
    return;
  }

  // Failure was already reported: no more feedback, keep the status current.
  if (state.reported) {
    record("FAILED");
    log({ result: "FAILED_SILENT", retries: state.attempts, notes });
    return;
  }

  const listed = listNotes(notes);

  if (state.attempts < MAX_RETRIES) {
    state.attempts += 1;
    saveState();
    record("RETRYING");
    log({ result: "BLOCK", retries: state.attempts, notes });
    emit({
      decision: "block",
      reason: [
        `tc validation FAILED (retry ${state.attempts}/${MAX_RETRIES}) — ${runRel} (indices ${compactRange(indices)})`,
        `Checked by: ${CHECKED_BY}, model ${model} — against "Acceptance criteria (LLM-reviewed)" in gt-test-case-generator/SKILL.md`,
        ...listed,
        ``,
        `Do not hand-edit tc-*.json or tc-steps-* — they are script output. For each index N above: delete`,
        `tc-N.json, tc-steps-N.md and tc-steps-N.xml in ${runRel}, then re-run the same script command`,
        `(resume-safe; --dedupe-by title reuses the tracker item). Add --us-id <us.json id> if parent_us_id is wrong.`,
        `If the cause is upstream (test-ideas.json itself, the tracker, a denied tool) or a note is plainly wrong`,
        `about the files, stop and say why instead of regenerating.`,
      ].join("\n"),
    });
    return;
  }

  // Retries used up: one last block asking for a failure report; `reported` silences later runs.
  state.reported = true;
  saveState();
  record("FAILED");
  log({ result: "FAILED", retries: state.attempts, notes });
  const validationRel = toRel(validationPath);
  emit({
    decision: "block",
    reason: [
      `tc validation FAILED — all ${MAX_RETRIES} retries are used up — ${runRel}`,
      `Stop regenerating test cases. Reply now with a message starting with this line:`,
      `TC VALIDATION FAILED after ${MAX_RETRIES} retries — ${runRel}`,
      `followed by these unresolved problems:`,
      ...listed,
      `Details: ${validationRel}`,
      `Inside flow-1a this is not an abort: after that report, continue with Phase 3.5.`,
    ].join("\n"),
    systemMessage: `test cases still invalid after ${MAX_RETRIES} retries — see ${validationRel}`,
  });
}

// ── command parsing ─────────────────────────────────────────────────────────

/** Value of `--name value` / `--name=value` (quoted or bare), first occurrence. */
function getArg(text, name) {
  const m = new RegExp(String.raw`--${name}(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s;&|)]+))`).exec(text);
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

/** `name=value` assignments anywhere in the command (e.g. `run_id=gtc-…; bash …`). */
function shellAssignments(command) {
  const vars = {};
  for (const m of command.matchAll(/(?:^|[\s;&(])([A-Za-z_]\w*)=(?:"([^"$]*)"|'([^']*)'|([^\s;&|$"'`]*))/g)) {
    vars[m[1]] = m[2] ?? m[3] ?? m[4];
  }
  return vars;
}

/** Expand $name / ${name} from known assignments; null if anything stays unresolved. */
function expand(value, vars) {
  if (value == null) return null;
  const out = value.replace(/\$\{(\w+)\}|\$(\w+)/g, (all, a, b) => vars[a ?? b] ?? all);
  return out.includes("$") ? null : out;
}

/** { dir, id } when absDir is .workflow-artifacts/<run…> (no dot-folders such as .hook-state), else null. */
function runDirOf(absDir) {
  const parts = toRel(absDir).split("/");
  if (parts[0] !== ".workflow-artifacts" || parts.length < 2) return null;
  const dirs = parts.slice(1);
  if (dirs.some((d) => d === "" || d.startsWith("."))) return null;
  return { dir: absDir, id: dirs.join("/") };
}

function existingTcIndices(dir) {
  try {
    return readdirSync(dir)
      .map((f) => /^tc-(\d+)\.json$/.exec(f)?.[1])
      .filter(Boolean)
      .map(Number)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

function listNotes(notes) {
  const shown = notes.slice(0, MAX_LISTED_NOTES).map((n) => `- ${n}`);
  if (notes.length > MAX_LISTED_NOTES) shown.push(`- … and ${notes.length - MAX_LISTED_NOTES} more (see tc.validation.json)`);
  return shown;
}

function compactRange(nums) {
  if (nums.length > 2 && nums.every((n, k) => k === 0 || n === nums[k - 1] + 1)) return `${nums[0]}–${nums.at(-1)}`;
  return nums.join(", ");
}

// ── io helpers ──────────────────────────────────────────────────────────────

function parseModel(argv) {
  const i = argv.indexOf("--model");
  const raw = i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith("--model="))?.slice("--model=".length);
  return raw ? String(raw) : DEFAULT_MODEL;
}

function log(fields) {
  try {
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(join(stateDir, "tc-gate.log"), JSON.stringify({ ts: new Date().toISOString(), ...logContext, ...fields }) + "\n");
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

function safe(s) {
  return String(s).replace(/[^\w.-]/g, "_");
}

// ── entry (last, so every module-level const above is initialised) ──────────

// Recursion guard: the reviewer session must never run this gate.
if (!process.env.TC_GATE_CHILD) {
  main().catch((e) => {
    // Never wedge the session on a gate bug: allow, but say so.
    emit({ systemMessage: `tc-gate crashed (allowed): ${e?.message ?? e}` });
    log({ result: "GATE_ERROR", error: String(e?.stack ?? e) });
    process.exitCode = 0;
  });
}
