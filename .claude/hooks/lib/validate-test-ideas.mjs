// Deterministic test-ideas.json contract check (see CLAUDE.md → "Artifact contracts" and
// .claude/skills/gt-test-ideation/SKILL.md → "test-ideas.json contract (validated)").
//
// Library:  import { validateTestIdeas, validateArtifact } from "./validate-test-ideas.mjs"
//           validateArtifact(absPath) → { errors, warnings, data } — the interface artifact-gate.mjs calls
// CLI:      node .claude/hooks/lib/validate-test-ideas.mjs <path/to/test-ideas.json>
//           → prints "PASS" (+ "note: …" lines) (exit 0) or one error per line (exit 1)
//
// Cross-checks read the siblings in the same run folder — the ground truth: scenarios.md (coverage + order) and
// us.json (ac_trace "ACn: <text>" = us.json.ac[n-1]). A missing sibling is an error (one note: wrong run folder;
// never fabricate it). Feedback rule: one note per problem, one fix per note.
// Test cases: .claude/hooks/test/run-artifact-gate-cases.mjs (fixtures/test-ideas/).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";

const STRING_LIST_FIELDS = ["conditions", "ideas", "verifications", "navigations"];

const isNonEmptyString = (v) => typeof v === "string" && v.trim() !== "";
const norm = (s) => s.replace(/\s+/g, " ").trim();

/**
 * @param {unknown} units parsed test-ideas.json
 * @param {{ scenarios?: string[] | null, acs?: string[] | null }} [context]
 *        scenarios = "## [P…]" heading texts from scenarios.md (null → coverage not checked)
 *        acs       = us.json.ac (null → "ACn: <text>" labels not checked)
 * @returns {string[]} human-readable errors; empty array means valid
 */
export function validateTestIdeas(units, { scenarios = null, acs = null } = {}) {
  const acCount = Array.isArray(acs) ? acs.length : null;
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
        `${unitLabel(u, i)}: ideas has ${u.ideas.length} items but verifications has ${u.verifications.length} → make them pair 1:1 (verifications[k] checks ideas[k]); every idea needs exactly one real verification — no filler or duplicate items to even the count`,
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
        const m = /^AC(\d+)\s*:\s*([\s\S]*)$/.exec(s.trim());
        if (!m || acCount === null) return;
        const n = Number(m[1]);
        if (n < 1 || n > acCount) {
          const have = acCount === 0 ? "us.json.ac is empty" : `us.json.ac has ${acCount} criteria (AC1–AC${acCount})`;
          errors.push(`${at}.ac_trace[${j}]: ${JSON.stringify(trunc(s))} → AC${n} does not exist; ${have}`);
          return;
        }
        // The text after "ACn:" must be us.json.ac[n-1] — real runs always quote it verbatim, so a different text
        // means the label points at the wrong criterion (or the criterion was reworded).
        const text = norm(m[2]);
        if (text === norm(String(acs[n - 1] ?? ""))) return;
        const other = acs.findIndex((ac) => norm(String(ac)) === text);
        errors.push(
          other >= 0
            ? `${at}.ac_trace[${j}]: ${JSON.stringify(trunc(s))} → this text is AC${other + 1} in us.json, not AC${n}; write it as "AC${other + 1}: <same text>"`
            : `${at}.ac_trace[${j}]: ${JSON.stringify(trunc(s))} → the text after "AC${n}:" must be us.json.ac[${n - 1}] verbatim: ${JSON.stringify(trunc(String(acs[n - 1])))}`,
        );
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

/**
 * Every scenarios.md heading exactly once, in order; no unit outside scenarios.md.
 * One problem → one note with one fix: a unit whose scenario is not a heading is first paired with a heading that has
 * no unit (same position, else the most similar one) — that is a mistyped/paraphrased heading, fixed by copying the
 * heading. Only unpaired units are "remove", and only unpaired headings are "add a unit".
 */
function checkCoverage(units, headings) {
  const errors = [];
  const expected = [...new Set(headings.map(norm))];
  const known = new Set(expected);
  const unitsOf = new Map(); // heading → unit indices that use it
  const unknown = []; // { i, s } units whose scenario is not a heading

  units.forEach((u, i) => {
    if (!u || typeof u !== "object" || !isNonEmptyString(u.scenario)) return;
    const s = norm(u.scenario);
    if (!known.has(s)) {
      unknown.push({ i, s });
      return;
    }
    if (!unitsOf.has(s)) unitsOf.set(s, []);
    unitsOf.get(s).push(i);
  });

  const missing = expected.map((s, k) => ({ k, s })).filter(({ s }) => !unitsOf.has(s));
  const paired = pairWithMissing(unknown, missing); // unit index → { k, s }
  const pairedHeadings = new Set([...paired.values()].map((m) => m.k));

  for (const { i, s } of unknown) {
    const m = paired.get(i);
    errors.push(
      m
        ? `unit[${i}].scenario: ${JSON.stringify(trunc(s))} is not a "## [P…]" heading in scenarios.md; heading #${m.k + 1} has no unit → replace it with exactly ${JSON.stringify(m.s)}`
        : `unit[${i}].scenario: ${JSON.stringify(trunc(s))} is not a "## [P…]" heading in scenarios.md and matches none of its uncovered headings → remove this unit (scenarios.md does not plan this scenario)`,
    );
  }

  expected.forEach((s, k) => {
    const at = unitsOf.get(s);
    if (!at) {
      if (!pairedHeadings.has(k)) errors.push(`scenarios.md heading #${k + 1} ${JSON.stringify(trunc(s))} has no unit → add a unit for it (in scenarios.md order)`);
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

/** Pair unknown units with uncovered headings: same position first, then best word overlap ≥ 0.3. */
function pairWithMissing(unknown, missing) {
  const pairs = new Map();
  const used = new Set();
  for (const u of unknown) {
    let best = missing.find((m) => m.k === u.i);
    if (best && used.has(best.k)) best = undefined;
    if (!best) {
      let score = 0.3;
      for (const m of missing) {
        if (used.has(m.k)) continue;
        const sim = similarity(u.s, m.s);
        if (sim >= score) [score, best] = [sim, m];
      }
    }
    if (best) {
      used.add(best.k);
      pairs.set(u.i, best);
    }
  }
  return pairs;
}

/** Jaccard overlap of lower-case words. */
function similarity(a, b) {
  const words = (s) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const A = words(a);
  const B = words(b);
  const inter = [...A].filter((w) => B.has(w)).length;
  const union = new Set([...A, ...B]).size;
  return union ? inter / union : 0;
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
  const errors = [];
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
  const md = readOrNull(join(dir, "scenarios.md"));
  const usRaw = readOrNull(join(dir, "us.json"));

  // Ground truth missing → one error, not a silent pass with skipped checks. gt-test-ideation cannot fix this by
  // editing test-ideas.json, and must never fabricate the planner's files to get past the check.
  const absent = [md === null && "scenarios.md", usRaw === null && "us.json"].filter(Boolean);
  if (absent.length) {
    const what = absent.join(" and ");
    errors.push(
      `${what}: not found next to test-ideas.json in ${shortPath(dir)} — gt-story-planner writes ${absent.length > 1 ? "them" : "it"}, and coverage/AC labels are checked against ${absent.length > 1 ? "them" : "it"} → write test-ideas.json into the run folder that holds this story's scenarios.md and us.json; never create or edit those files yourself`,
    );
  }

  let scenarios = null;
  if (md !== null) {
    scenarios = parseScenarioHeadings(md);
    if (scenarios.length === 0) {
      warnings.push('scenarios.md has no "## [P…]" headings → scenario coverage/order not checked');
      scenarios = null;
    }
  }

  let acs = null;
  if (usRaw !== null) {
    let us = null;
    try {
      us = JSON.parse(usRaw.replace(/^﻿/, ""));
    } catch {
      /* handled below */
    }
    if (Array.isArray(us?.ac)) acs = us.ac;
    else warnings.push("us.json is not valid JSON with an ac array → ac_trace AC labels not checked");
  }

  errors.push(...validateTestIdeas(data, { scenarios, acs }));
  return { errors, warnings, data };
}

/** Path relative to the working directory when inside it (as hooks run from the project root), else absolute. */
function shortPath(p) {
  const rel = relative(process.cwd(), p);
  return (rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : p).split("\\").join("/");
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
