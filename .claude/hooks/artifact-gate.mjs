// Feedback-loop gate for artifacts written by INLINE skills — skills that run in the main agent,
// not in a forked subagent, so there is no SubagentStop to hook into (compare us-json-gate.mjs).
//
//   node .claude/hooks/artifact-gate.mjs --trigger write|stop [--artifact <name>]   (hook input JSON on stdin)
//
// Config: .claude/hooks/artifact-gate.json — one entry per artifact file name, e.g.
//   "test-ideas.json": { "skill": "gt-test-ideation", "trigger": "write",
//                        "validator": "lib/validate-test-ideas.mjs", "max_retries": 3,
//                        "skip_stop_if_present": ["tc-*.json", "links.json"] }
// "trigger" is the switch: the gate only acts when it equals --trigger, so one option is live at a time.
//
//   write → PostToolUse hook on Write|Edit (.claude/settings.json). Fires the moment the artifact is
//           written, also mid-pipeline. Fail → {"decision":"block","reason":...} on stdout; the reason is
//           shown next to the tool result, so the agent sees it straight away.
//   stop  → Stop hook in the skill's own frontmatter (once: true). Fires when the main agent's turn ends.
//           Fail → reason on stderr + exit 2 (a blocking exit keeps a `once` hook registered; exit 0 removes it).
//           SKIPPED when the run folder already has a file from "skip_stop_if_present" — i.e. the turn
//           that ended was a whole flow-1a run, which is long past this stage.
//
// Validator module: `export function validateArtifact(absPath) → { errors: string[], warnings?: string[] }`.
//
// Bounded loop per (session, run folder, artifact): up to max_retries feedback blocks, then one last block
// asking for a "<STEM> VALIDATION FAILED after N retries — <path>" report, then no more feedback (later runs
// re-validate silently, so the status can still flip to PASSED).
// Status: {run_dir}/<stem>.validation.json     State + log: .workflow-artifacts/.hook-state/

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname, relative, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(HOOKS_DIR, "artifact-gate.json");
const TRIGGERS = ["write", "stop"];
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);
const DEFAULT_MAX_RETRIES = 3;
const MAX_LISTED_ERRORS = 20;

let projectDir = process.cwd();
let stateDir = join(projectDir, ".workflow-artifacts", ".hook-state");
let trigger = null;
let logContext = {};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  trigger = args.trigger;
  const input = parseJson(readStdin()) ?? {};

  projectDir = resolve(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
  stateDir = join(projectDir, ".workflow-artifacts", ".hook-state");
  const sessionId = String(input.session_id || "unknown");

  // ── 1. Which artifact, and is this trigger the active one ──────────────────
  const config = loadConfig();
  let artifact;
  let filePath = null;
  if (trigger === "write") {
    const fp = input.tool_input?.file_path;
    if (typeof fp !== "string" || fp === "") return;
    artifact = fileName(fp);
    if (!Object.hasOwn(config, artifact)) return; // unrelated write: no output, no log
    filePath = resolve(projectDir, fp);
    if (!runDirOf(filePath)) return; // not .workflow-artifacts/<run>/<artifact>
  } else {
    artifact = args.artifact;
    if (!artifact) throw new Error("--trigger stop needs --artifact <file name>");
  }

  logContext = { trigger, artifact, session_id: sessionId };
  const entry = Object.hasOwn(config, artifact) ? config[artifact] : null;
  if (!entry) {
    log({ result: "NOT_CONFIGURED" });
    return;
  }
  if (entry.trigger !== trigger) {
    log({ result: "INACTIVE", configured_trigger: entry.trigger ?? null });
    return;
  }

  // ── 2. Locate the file ─────────────────────────────────────────────────────
  if (trigger === "stop") {
    filePath = locateFromTranscript(readTranscript(input.transcript_path), artifact, entry.skill);
    if (!filePath) {
      log({ result: "NO_ARTIFACT" });
      emit({ systemMessage: `artifact-gate: no .workflow-artifacts/<run_id>/${artifact} was written this turn — nothing validated` });
      return;
    }
  }
  const runDir = runDirOf(filePath);
  const rel = toRel(filePath);
  logContext.path = rel;

  // ── 3. Pipeline guard (stop only) ──────────────────────────────────────────
  if (trigger === "stop") {
    const marker = findPresent(runDir.dir, entry.skip_stop_if_present ?? []);
    if (marker) {
      log({ result: "SKIPPED", reason: `run folder already has ${marker} — past this stage` });
      return;
    }
  }

  // ── 4. Validate ────────────────────────────────────────────────────────────
  const maxRetries = Number.isInteger(entry.max_retries) && entry.max_retries >= 0 ? entry.max_retries : DEFAULT_MAX_RETRIES;
  const { errors, warnings } = await runValidator(entry.validator, filePath);

  // ── 5. Retry state (per session + run folder + artifact) ───────────────────
  const stem = artifact.replace(/\.json$/i, "");
  const statePath = join(stateDir, `artifact-gate-${safe(runDir.id)}-${safe(stem)}.json`);
  let state = parseJson(readOrNull(statePath));
  if (!state || state.session_id !== sessionId) state = { attempts: 0, reported: false, session_id: sessionId };
  const saveState = () => writeJson(statePath, { ...state, path: rel, updated_at: new Date().toISOString() });

  const validationPath = join(runDir.dir, `${stem}.validation.json`);
  const record = (status) =>
    writeJson(validationPath, {
      status,
      retries: state.attempts,
      max_retries: maxRetries,
      trigger,
      validator: entry.validator,
      path: rel,
      notes: errors,
      ...(warnings.length ? { warnings } : {}),
      checked_at: new Date().toISOString(),
    });

  // ── 6. Decide ──────────────────────────────────────────────────────────────
  if (errors.length === 0) {
    record("PASSED");
    log({ result: "PASSED", retries: state.attempts, ...(warnings.length ? { warnings } : {}) });
    return;
  }

  // Failure was already reported: no more feedback, keep the status current.
  if (state.reported) {
    record("FAILED");
    log({ result: "FAILED_SILENT", retries: state.attempts, errors });
    return;
  }

  const listed = listErrors(errors, entry.validator, rel);

  if (state.attempts < maxRetries) {
    state.attempts += 1;
    saveState();
    record("RETRYING");
    log({ result: "BLOCK", retries: state.attempts, errors });
    block(
      [
        `${artifact} validation FAILED (retry ${state.attempts}/${maxRetries}) — ${rel}`,
        `Checked by: ${entry.validator} (trigger: ${trigger})`,
        ...listed,
        ``,
        `Fix ${artifact} in place (same run folder, same path) so every point above is resolved${trigger === "stop" ? ", then finish again" : ""}.`,
        `If something outside your control blocks the fix (e.g. a denied tool, or the inputs it is built from are wrong), stop and say why instead.`,
      ].join("\n"),
    );
    return;
  }

  // Retries used up: one last block asking for a failure report; `reported` silences later runs.
  state.reported = true;
  saveState();
  record("FAILED");
  log({ result: "FAILED", retries: state.attempts, errors });
  const validationRel = toRel(validationPath);
  block(
    [
      `${artifact} validation FAILED — all ${maxRetries} retries are used up — ${rel}`,
      `Stop fixing it and do not continue with work that depends on it. Reply now with a message starting with this line:`,
      `${stem.toUpperCase()} VALIDATION FAILED after ${maxRetries} retries — ${rel}`,
      `followed by these unresolved problems:`,
      ...listed,
      `Details: ${validationRel}`,
    ].join("\n"),
    `${artifact} still invalid after ${maxRetries} retries — see ${validationRel}`,
  );
}

// ── feedback ────────────────────────────────────────────────────────────────

/** write → JSON decision on stdout (exit 0); stop → stderr + exit 2 (JSON is ignored on exit 2). */
function block(reason, systemMessage) {
  if (trigger === "write") {
    emit({ decision: "block", reason, ...(systemMessage ? { systemMessage } : {}) });
    return;
  }
  process.stderr.write(reason + (systemMessage ? `\n\n(${systemMessage})` : "") + "\n");
  process.exitCode = 2;
}

function listErrors(errors, validator, rel) {
  const shown = errors.slice(0, MAX_LISTED_ERRORS).map((e) => `- ${e}`);
  if (errors.length > MAX_LISTED_ERRORS) {
    const cli = toRel(join(HOOKS_DIR, validator));
    shown.push(`- … and ${errors.length - MAX_LISTED_ERRORS} more (full list: node ${cli} ${rel})`);
  }
  return shown;
}

async function runValidator(validator, absPath) {
  if (typeof validator !== "string" || !validator) throw new Error("config entry has no \"validator\" module path");
  const mod = await import(pathToFileURL(join(HOOKS_DIR, validator)).href);
  if (typeof mod.validateArtifact !== "function") throw new Error(`${validator} does not export validateArtifact(absPath)`);
  const res = await mod.validateArtifact(absPath);
  return { errors: res?.errors ?? [], warnings: res?.warnings ?? [] };
}

// ── locating the artifact ───────────────────────────────────────────────────

/** { dir, id } when absPath is .workflow-artifacts/<run…>/<file> (no dot-folders such as .hook-state), else null. */
function runDirOf(absPath) {
  const parts = toRel(absPath).split("/");
  if (parts[0] !== ".workflow-artifacts" || parts.length < 3) return null;
  const dirs = parts.slice(1, -1);
  if (dirs.some((d) => d === "" || d.startsWith("."))) return null;
  return { dir: dirname(absPath), id: dirs.join("/") };
}

/**
 * Stop trigger: the artifact this skill run wrote, from the main transcript — never a "newest file" guess.
 * Only tool calls after the last invocation of the configured skill count (whole transcript if none found).
 *   1. last Write/Edit targeting .workflow-artifacts/<run>/<artifact>
 *   2. last mention of that path in any tool call (e.g. a Bash redirect)
 */
function locateFromTranscript(entries, artifact, skill) {
  const mentionRe = new RegExp(
    String.raw`\.workflow-artifacts((?:[\\/]+[^\\/"'\x60\s*?{}$<>|]+)+?)[\\/]+` + escapeRe(artifact) + String.raw`(?![\w-]|\.\w)`,
    "g",
  );
  const writes = [];
  const mentions = [];
  for (const block of toolUses(entries.slice(lastSkillStart(entries, skill)))) {
    const input = block.input ?? {};
    if (WRITE_TOOLS.has(block.name) && typeof input.file_path === "string" && fileName(input.file_path) === artifact) {
      const abs = resolve(projectDir, input.file_path);
      if (runDirOf(abs)) writes.push(abs);
    }
    for (const m of JSON.stringify(input).matchAll(mentionRe)) {
      const abs = join(projectDir, ".workflow-artifacts", ...m[1].split(/[\\/]+/).filter(Boolean), artifact);
      if (runDirOf(abs)) mentions.push(abs);
    }
  }
  return writes.at(-1) ?? mentions.at(-1) ?? null;
}

/** Index of the last transcript entry that invoked `skill` (Skill tool call or /slash command), else 0. */
function lastSkillStart(entries, skill) {
  if (!skill) return 0;
  const commandTag = new RegExp(String.raw`<command-name>/?(?:[\w-]+:)?` + escapeRe(skill) + String.raw`</command-name>`);
  const isSkill = (name) => typeof name === "string" && (name === skill || name.endsWith(`:${skill}`) || name === `/${skill}`);
  let start = 0;
  entries.forEach((e, i) => {
    const content = e?.message?.content;
    if (Array.isArray(content) && content.some((b) => b?.type === "tool_use" && b.name === "Skill" && isSkill(b.input?.skill))) start = i;
    if (e?.type === "user") {
      const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
      if (commandTag.test(text)) start = i;
    }
  });
  return start;
}

function findPresent(dir, patterns) {
  if (!patterns.length) return null;
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return null;
  }
  for (const p of patterns) {
    const re = new RegExp("^" + p.split("*").map(escapeRe).join(".*") + "$");
    const hit = files.find((f) => re.test(f));
    if (hit) return hit;
  }
  return null;
}

// ── transcript helpers ──────────────────────────────────────────────────────

function readTranscript(path) {
  if (!path) return [];
  const p = path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
  const raw = readOrNull(p);
  if (!raw) return [];
  return raw.split(/\r?\n/).map(parseJson).filter(Boolean);
}

function toolUses(entries) {
  const out = [];
  for (const e of entries) {
    const content = e?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) if (b?.type === "tool_use") out.push(b);
  }
  return out;
}

// ── io helpers ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const get = (name) => {
    const i = argv.indexOf(`--${name}`);
    if (i >= 0) return argv[i + 1];
    return argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  };
  const t = String(get("trigger") ?? "").toLowerCase();
  if (!TRIGGERS.includes(t)) throw new Error(`--trigger must be one of ${TRIGGERS.join("|")}, got "${t}"`);
  return { trigger: t, artifact: get("artifact") ?? null };
}

function loadConfig() {
  const config = parseJson(readOrNull(CONFIG_PATH));
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`cannot read config ${toRel(CONFIG_PATH)}`);
  return config;
}

function log(fields) {
  try {
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(join(stateDir, "artifact-gate.log"), JSON.stringify({ ts: new Date().toISOString(), ...logContext, ...fields }) + "\n");
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

function fileName(p) {
  return p.split(/[\\/]/).pop();
}

function toRel(p) {
  const r = isAbsolute(p) ? relative(projectDir, p) : p;
  return r.split("\\").join("/");
}

function safe(s) {
  return String(s).replace(/[^\w.-]/g, "_");
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── entry (last, so every module-level const above is initialised) ──────────

main().catch((e) => {
  // Never wedge the session on a gate bug: allow, but say so.
  emit({ systemMessage: `artifact-gate crashed (allowed): ${e?.message ?? e}` });
  log({ result: "GATE_ERROR", error: String(e?.stack ?? e) });
  process.exitCode = 0;
});
