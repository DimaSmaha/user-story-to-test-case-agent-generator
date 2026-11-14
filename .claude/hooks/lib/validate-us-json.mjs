// Deterministic us.json contract check (see CLAUDE.md → "Artifact contracts").
//
// Library:  import { validateUsJson, validateUsJsonFile } from "./validate-us-json.mjs"
// CLI:      node .claude/hooks/lib/validate-us-json.mjs <path/to/us.json>
//           → prints "PASS" (exit 0) or one error per line (exit 1)

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, join, dirname, relative } from "node:path";

const isNonEmptyString = (v) => typeof v === "string" && v.trim() !== "";

/** @returns {string[]} human-readable errors; empty array means valid */
export function validateUsJson(us) {
  if (us === null || typeof us !== "object" || Array.isArray(us)) {
    return ["us.json: must be a JSON object → write { id, title, description, ac, url }"];
  }

  const errors = [];

  if (!isNonEmptyString(us.id)) {
    errors.push(
      `id: ${describe(us.id)} → must be a non-empty string (tracker id as a string, e.g. "114", or "manual" for pasted text)`,
    );
  }

  if (!isNonEmptyString(us.title)) {
    errors.push(`title: ${describe(us.title)} → copy the story title from the tracker / pasted text`);
  }

  if (typeof us.description !== "string") {
    errors.push(`description: ${describe(us.description)} → must be a string (full story description)`);
  }

  if (!Array.isArray(us.ac)) {
    errors.push(`ac: ${describe(us.ac)} → must be an array of acceptance-criteria strings`);
  } else if (us.ac.length === 0) {
    errors.push("ac: is an empty array → add at least one acceptance criterion (derive from the description if the tracker has none)");
  } else {
    us.ac.forEach((item, i) => {
      if (!isNonEmptyString(item)) {
        errors.push(`ac[${i}]: ${describe(item)} → every acceptance criterion must be a non-empty string`);
      }
    });
  }

  const isManual = us.id === "manual";
  if (!("url" in us)) {
    errors.push(`url: is missing → use the tracker URL, or null when id is "manual"`);
  } else if (isManual && us.url !== null) {
    errors.push(`url: ${describe(us.url)} → must be null when id is "manual"`);
  } else if (!isManual && !isNonEmptyString(us.url)) {
    errors.push(`url: ${describe(us.url)} → must be the tracker URL of story ${JSON.stringify(us.id ?? "")}`);
  }

  return errors;
}

/**
 * File-level check: the us.json contract, plus the run-folder rule that a tracker story must have its
 * ground truth next to it — tracker-source.json (the verbatim get.sh output) is what the fidelity
 * review compares against, so without it the only valid fix is to restore it.
 * @returns {{ errors: string[], data: unknown }}
 */
export function validateUsJsonFile(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { errors: [`us.json: file not found at ${path} → write it to .workflow-artifacts/{run_id}/us.json`], data: null };
  }
  let data;
  try {
    data = JSON.parse(raw.replace(/^﻿/, ""));
  } catch (e) {
    return { errors: [`us.json: invalid JSON (${e.message}) → rewrite the file as valid JSON`], data: null };
  }
  const errors = validateUsJson(data);
  const id = data !== null && typeof data === "object" ? data.id : undefined;
  const isTrackerStory = (typeof id === "number" || isNonEmptyString(id)) && id !== "manual";
  const sourcePath = join(dirname(path), "tracker-source.json");
  if (isTrackerStory && !existsSync(sourcePath)) {
    errors.push(
      `tracker-source.json: missing next to us.json for tracker story ${JSON.stringify(id)} → re-run get.sh --id ${id} and save its verbatim output to ${shortPath(sourcePath)} (do not switch the story to "manual")`,
    );
  }
  return { errors, data };
}

/** Path relative to the working directory (the project root for the hook and the CLI), POSIX slashes. */
function shortPath(p) {
  const rel = relative(process.cwd(), p);
  return (rel && !rel.startsWith("..") ? rel : p).split("\\").join("/");
}

function describe(v) {
  if (v === undefined) return "is missing";
  if (v === null) return "is null";
  if (typeof v === "string") return v.trim() === "" ? `is an empty string ${JSON.stringify(v)}` : `is ${JSON.stringify(v)}`;
  if (Array.isArray(v)) return `is an array`;
  return `is a ${typeof v} (${JSON.stringify(v)})`;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: node .claude/hooks/lib/validate-us-json.mjs <path/to/us.json>");
    process.exit(2);
  }
  const { errors } = validateUsJsonFile(target);
  if (errors.length === 0) {
    console.log("PASS");
    process.exit(0);
  }
  for (const e of errors) console.log(`- ${e}`);
  process.exit(1);
}
