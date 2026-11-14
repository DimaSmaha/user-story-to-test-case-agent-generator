// Shared helpers for the offline gate runners (run-artifact-gate-cases.mjs, run-tc-gate-cases.mjs).
// Every runner plays the agent: it puts fixture files where a real run would write them, pipes a hook input into
// the real gate, classifies each gate call, and compares the outcome sequence with the case's labelled expectation.

import { readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "..", "..", "..");
export const ARTIFACTS = join(ROOT, ".workflow-artifacts");
export const TRANSCRIPTS = join(ARTIFACTS, ".hook-test");
export const STATE_DIR = join(ARTIFACTS, ".hook-state");

/** Generic flags; `extra` maps further flag names to option keys (e.g. { "--trigger": "trigger" }). */
export function parseArgs(argv, extra = {}) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split("=", 2);
    const value = () => inline ?? argv[++i];
    if (flag === "--case") out.case = String(value()).split(",").filter(Boolean);
    else if (flag === "--json") out.json = value();
    else if (flag === "--keep") out.keep = true;
    else if (flag === "--verbose" || flag === "-v") out.verbose = true;
    else if (Object.hasOwn(extra, flag)) out[extra[flag]] = String(value());
    else fatal(`unknown argument "${argv[i]}"`);
  }
  return out;
}

/** Case folders under `fixturesDir` (folders starting with "_" are shared bases), filtered by --case substrings. */
export function listCases(fixturesDir, filter) {
  const names = readdirSync(fixturesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .map((d) => d.name)
    .filter((name) => !filter || filter.some((c) => name.includes(c)))
    .sort();
  if (names.length === 0) fatal(`no fixture matches --case ${filter?.join(",")}`);
  return names;
}

/** Common assertions over the steps of one case. `steps[i].status` = the status file after call i. */
export function checkAsserts(a, steps) {
  const lastStatus = [...steps].reverse().find((s) => s.status)?.status ?? {};
  const firstNotes = steps.find((s) => s.status?.notes?.length && s.feedback)?.status.notes ?? [];
  const errors = [];
  if ("retries" in a && lastStatus.retries !== a.retries) errors.push(`retries is ${lastStatus.retries}, expected ${a.retries}`);
  if ("notes_count" in a && firstNotes.length !== a.notes_count) errors.push(`first feedback has ${firstNotes.length} notes, expected ${a.notes_count}`);
  if (a.notes_match && !new RegExp(a.notes_match, "i").test(firstNotes.join("\n"))) errors.push(`first feedback notes do not match /${a.notes_match}/i`);
  if (a.reason_includes && !steps.some((s) => s.reason.includes(a.reason_includes))) errors.push(`no gate output contains "${a.reason_includes}"`);
  if (a.last_reason_includes && !String(steps.at(-1)?.reason ?? "").includes(a.last_reason_includes)) {
    errors.push(`last gate output does not contain "${a.last_reason_includes}"`);
  }
  return errors;
}

export function mismatchKind(expected, actual) {
  const defective = expected[0] !== "PASS";
  if (defective && actual[0] === "PASS") return "false pass — the validator missed a labelled defect";
  if (!defective && actual[0] === "BLOCK") return "false fail — the validator flagged a correct file";
  if (expected[0] === "BLOCK" && actual[0] === "BLOCK" && expected[1] === "PASS" && actual[1] === "BLOCK") {
    return "fix not accepted — the corrected version was flagged again";
  }
  return "different outcome";
}

export function printRow(r, { verbose, width = 28, feedbackOutcomes = ["BLOCK", "FINAL", "BLOCKED"], extra = () => "" }) {
  if (r.result === "skipped") {
    console.log(`  -   ${r.name.padEnd(width)} skipped (${r.note})`);
    return;
  }
  const mark = r.result === "ok" ? "ok " : "XX ";
  const seq = r.actual.join("→");
  const time = r.ms.map(fmtMs).join(" + ");
  const tags = `${r.blind_spot ? "  [expected blind spot]" : ""}${r.probe ? "  [probe]" : ""}`;
  console.log(`  ${mark} ${r.name.padEnd(width)} ${seq.padEnd(34)} retries=${String(r.retries).padEnd(4)} ${time}${extra(r)}${tags}`);
  if (r.result !== "ok") {
    console.log(`        expected ${r.expected.join("→")} — ${r.kind}`);
    for (const e of r.assert_errors) console.log(`        assert: ${e}`);
  }
  if (r.result !== "ok" || verbose) {
    r.steps.forEach((s, i) => {
      console.log(`        call ${i + 1}: ${s.outcome} (${fmtMs(s.ms)})${s.label ? ` — ${s.label}` : ""}`);
      if (feedbackOutcomes.includes(s.outcome)) for (const n of s.notes) console.log(`          - ${n}`);
      if (!feedbackOutcomes.includes(s.outcome) && s.reason) console.log(`          ${s.reason.split("\n")[0]}`);
    });
  }
}

export function printSummary(rs, label) {
  const ran = rs.filter((r) => r.result !== "skipped");
  const bad = ran.filter((r) => r.result === "MISMATCH");
  const blind = ran.filter((r) => r.blind_spot);
  const calls = ran.reduce((n, r) => n + r.ms.length, 0);
  const totalMs = ran.reduce((n, r) => n + r.ms.reduce((a, b) => a + b, 0), 0);
  console.log(`\n${ran.length - bad.length}/${ran.length} cases as expected, ${rs.length - ran.length} skipped — ${calls} gate calls, ${fmtMs(totalMs)} total`);
  if (blind.length) console.log(`expected blind spots of ${label} (defect present, validator passes it): ${blind.map((r) => r.name).join(", ")}`);
  if (bad.length) console.log(`MISMATCH: ${bad.map((r) => `${r.name} (${r.kind})`).join("; ")}`);
}

/** Remove the transcript folder only when empty — another runner may still be using it. */
export function removeTranscriptDirIfEmpty() {
  if (existsSync(TRANSCRIPTS) && readdirSync(TRANSCRIPTS).length === 0) rmSync(TRANSCRIPTS, { recursive: true, force: true });
}

export function fmtMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export function lastJsonLine(stdout) {
  return parseJson(String(stdout ?? "").trim().split(/\r?\n/).pop()) ?? {};
}

export function readJson(path) {
  const parsed = parseJson(readOrNull(path));
  if (parsed === null) fatal(`cannot read JSON from ${path}`);
  return parsed;
}

export function readOrNull(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

export function fatal(msg) {
  console.error(msg);
  process.exit(2);
}
