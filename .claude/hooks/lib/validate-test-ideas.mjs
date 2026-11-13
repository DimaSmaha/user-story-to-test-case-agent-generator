// Deterministic test-ideas.json contract check (see CLAUDE.md → "Artifact contracts" and
// .claude/skills/gt-test-ideation/SKILL.md → "test-ideas.json contract (validated)").
//
// Library:  import { validateTestIdeas, validateArtifact } from "./validate-test-ideas.mjs"
//           validateArtifact(absPath) → { errors, warnings, data } — the interface artifact-gate.mjs calls
// CLI:      node .claude/hooks/lib/validate-test-ideas.mjs <path/to/test-ideas.json>
//           → prints "PASS" (+ "note: …" lines) (exit 0) or one error per line (exit 1)
//
// Cross-checks read the siblings in the same run folder: scenarios.md (coverage + order) and
// us.json (ac_trace "ACn:" labels). A missing sibling skips that check and adds a warning.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const STRING_LIST_FIELDS = ["conditions", "ideas", "verifications", "navigations"];

const isNonEmptyString = (v) => typeof v === "string" && v.trim() !== "";
const norm = (s) => s.replace(/\s+/g, " ").trim();

/**
 * @param {unknown} units parsed test-ideas.json
 * @param {{ scenarios?: string[] | null, acCount?: number | null }} [context]
 *        scenarios = "## [P…]" heading texts from scenarios.md (null → coverage not checked)
 *        acCount   = us.json.ac.length (null → ACn labels not checked)
 * @returns {string[]} human-readable errors; empty array means valid
 */
export function validateTestIdeas(units, { scenarios = null, acCount = null } = {}) {
  if (!Array.isArray(units)) {
    return [`test-ideas.json: ${describe(units)} → must be a JSON array of ideation units [ { index, scenario, ... }, ... ]`];
  }
  if (units.length === 0) {
    return ["test-ideas.json: is an empty array → add one unit per non-SKIP scenario in scenarios.md"];
  }

  const errors = [];

  units.forEach((u, i) => {
    const at = `unit[${i}]`;
    if (u === null || typeof u !== "object" || Array.isArray(u)) {
      errors.push(
        `${at}: ${describe(u)} → every unit must be an object { index, scenario, conditions, ideas, verifications, navigations, ac_trace, reusable_helpers }`,
      );
      return;
    }

    if (!Number.isInteger(u.index) || u.index !== i) {
      errors.push(`${at}.index: ${describe(u.index)} → must be the integer ${i} (its position in the array)`);
    }

    if (!isNonEmptyString(u.scenario) || !/^\[P\d+\] \S/.test(u.scenario.trim())) {
      errors.push(
        `${at}.scenario: ${describe(u.scenario)} → must be a "## [P…]" heading text from scenarios.md without "## ", e.g. "[P1] Auth: Login with valid credentials succeeds"`,
      );
    }

    for (const field of STRING_LIST_FIELDS) {
      const v = u[field];
      if (!Array.isArray(v)) {
        errors.push(`${at}.${field}: ${describe(v)} → must be an array of non-empty strings`);
      } else if (v.length === 0) {
        errors.push(`${at}.${field}: is an empty array → add at least one item`);
      } else {
        v.forEach((s, j) => {
          if (!isNonEmptyString(s)) errors.push(`${at}.${field}[${j}]: ${describe(s)} → must be a non-empty string`);
        });
      }
    }

    if (Array.isArray(u.ideas) && Array.isArray(u.verifications) && u.ideas.length !== u.verifications.length) {
      errors.push(
        `${unitLabel(u, i)}: ideas has ${u.ideas.length} items but verifications has ${u.verifications.length} → they must be the same length; verifications[k] checks ideas[k]`,
      );
    }

    const trace = u.ac_trace;
    if (!Array.isArray(trace)) {
      errors.push(`${at}.ac_trace: ${describe(trace)} → must be an array of "ACn: <criterion>" strings from us.json.ac`);
    } else if (trace.length === 0) {
      errors.push(`${at}.ac_trace: is an empty array → add at least one "ACn: <criterion>" this scenario covers`);
    } else {
      trace.forEach((s, j) => {
        if (!isNonEmptyString(s)) {
          errors.push(`${at}.ac_trace[${j}]: ${describe(s)} → must be a non-empty string`);
          return;
        }
        const m = /^AC(\d+)\s*:/.exec(s.trim());
        if (!m || acCount === null) return;
        const n = Number(m[1]);
        if (n < 1 || n > acCount) {
          const have = acCount === 0 ? "us.json.ac is empty" : `us.json.ac has ${acCount} criteria (AC1–AC${acCount})`;
          errors.push(`${at}.ac_trace[${j}]: ${JSON.stringify(trunc(s))} → AC${n} does not exist; ${have}`);
        }
      });
    }

    const helpers = u.reusable_helpers;
    if (!Array.isArray(helpers)) {
      errors.push(`${at}.reusable_helpers: ${describe(helpers)} → must be an array of strings (use [] when none apply)`);
    } else {
      helpers.forEach((s, j) => {
        if (!isNonEmptyString(s)) errors.push(`${at}.reusable_helpers[${j}]: ${describe(s)} → must be a non-empty string`);
      });
    }
  });

  if (scenarios) errors.push(...checkCoverage(units, scenarios));

  return errors;
}

/** Every scenarios.md heading exactly once, in order; no unit outside scenarios.md. */
function checkCoverage(units, headings) {
  const errors = [];
  const expected = [...new Set(headings.map(norm))];
  const known = new Set(expected);
  const unitsOf = new Map(); // heading → unit indices that use it

  units.forEach((u, i) => {
    if (!u || typeof u !== "object" || !isNonEmptyString(u.scenario)) return;
    const s = norm(u.scenario);
    if (!known.has(s)) {
      errors.push(
        `unit[${i}].scenario: ${JSON.stringify(trunc(s))} is not a "## [P…]" heading in scenarios.md → copy the heading text exactly (without "## "), or remove the unit`,
      );
      return;
    }
    if (!unitsOf.has(s)) unitsOf.set(s, []);
    unitsOf.get(s).push(i);
  });

  expected.forEach((s, k) => {
    const at = unitsOf.get(s);
    if (!at) {
      errors.push(`scenarios.md heading #${k + 1} ${JSON.stringify(trunc(s))} has no unit → add a unit for it (in scenarios.md order)`);
    } else if (at.length > 1) {
      errors.push(
        `scenario ${JSON.stringify(trunc(s))} appears in ${at.length} units (${at.map((i) => `unit[${i}]`).join(", ")}) → keep exactly one`,
      );
    }
  });

  // Order, among the headings that do have a unit (first occurrence of each).
  const actual = [...unitsOf.entries()].sort((a, b) => a[1][0] - b[1][0]).map(([s]) => s);
  const wanted = expected.filter((s) => unitsOf.has(s));
  const k = wanted.findIndex((s, j) => s !== actual[j]);
  if (k >= 0) {
    errors.push(
      `unit order differs from scenarios.md: unit[${unitsOf.get(actual[k])[0]}] is ${JSON.stringify(trunc(actual[k]))} but the next heading in scenarios.md is ${JSON.stringify(trunc(wanted[k]))} → order units as the headings appear in scenarios.md`,
    );
  }

  return errors;
}

/** "## [P…] <text>" headings (level 2 only; [SKIP] and charter headings are ignored). */
export function parseScenarioHeadings(markdown) {
  return markdown
    .split(/\r?\n/)
    .map((line) => /^##\s+(\[P\d+\]\s+.*\S)\s*$/.exec(line)?.[1])
    .filter(Boolean);
}

/** @returns {{ errors: string[], warnings: string[], data: unknown }} */
export function validateArtifact(absPath) {
  const warnings = [];

  const raw = readOrNull(absPath);
  if (raw === null) {
    return {
      errors: [`test-ideas.json: file not found at ${absPath} → write it to .workflow-artifacts/{run_id}/test-ideas.json`],
      warnings,
      data: null,
    };
  }
  let data;
  try {
    data = JSON.parse(raw.replace(/^﻿/, ""));
  } catch (e) {
    return { errors: [`test-ideas.json: invalid JSON (${e.message}) → rewrite the file as valid JSON`], warnings, data: null };
  }

  const dir = dirname(absPath);

  let scenarios = null;
  const md = readOrNull(join(dir, "scenarios.md"));
  if (md === null) {
    warnings.push("scenarios.md not found next to test-ideas.json → scenario coverage/order not checked");
  } else {
    scenarios = parseScenarioHeadings(md);
    if (scenarios.length === 0) {
      warnings.push('scenarios.md has no "## [P…]" headings → scenario coverage/order not checked');
      scenarios = null;
    }
  }

  let acCount = null;
  const usRaw = readOrNull(join(dir, "us.json"));
  if (usRaw === null) {
    warnings.push("us.json not found next to test-ideas.json → ac_trace AC labels not checked");
  } else {
    let us = null;
    try {
      us = JSON.parse(usRaw.replace(/^﻿/, ""));
    } catch {
      /* handled below */
    }
    if (Array.isArray(us?.ac)) acCount = us.ac.length;
    else warnings.push("us.json is not valid JSON with an ac array → ac_trace AC labels not checked");
  }

  return { errors: validateTestIdeas(data, { scenarios, acCount }), warnings, data };
}

function unitLabel(u, i) {
  return isNonEmptyString(u?.scenario) ? `unit[${i}] (${JSON.stringify(trunc(u.scenario, 60))})` : `unit[${i}]`;
}

function trunc(s, max = 80) {
  const t = norm(String(s));
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function describe(v) {
  if (v === undefined) return "is missing";
  if (v === null) return "is null";
  if (typeof v === "string") return v.trim() === "" ? `is an empty string ${JSON.stringify(v)}` : `is ${JSON.stringify(trunc(v))}`;
  if (Array.isArray(v)) return "is an array";
  if (typeof v === "object") return "is an object";
  return `is a ${typeof v} (${JSON.stringify(v)})`;
}

function readOrNull(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: node .claude/hooks/lib/validate-test-ideas.mjs <path/to/test-ideas.json>");
    process.exit(2);
  }
  const { errors, warnings } = validateArtifact(resolve(target));
  if (errors.length === 0) {
    console.log("PASS");
    for (const w of warnings) console.log(`note: ${w}`);
    process.exit(0);
  }
  for (const e of errors) console.log(`- ${e}`);
  for (const w of warnings) console.log(`note: ${w}`);
  process.exit(1);
}
