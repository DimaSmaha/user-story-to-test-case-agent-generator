// LLM review of gt-test-case-generator output — ONE plain LLM call, no tools (same mechanism as
// review-us-json-llm.mjs, the "llm" mode of us-json-gate).
//
// The files are pasted into the prompt; the model answers once, as SDK structured output.
// Rules = the "## Acceptance criteria (LLM-reviewed)" section of the skill's own SKILL.md, so the
// generating agent and the reviewer read the same contract.
//
// Isolation: settingSources: [] → no hooks, CLAUDE.md, skills or agents are loaded.
// reviewDigest() hashes what the reviewer is shown (minus command/stdout) so tc-gate can reuse a verdict for
// identical evidence instead of asking the model again.

import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export const DEFAULT_MODEL = "sonnet";
const TIMEOUT_MS = 180_000;
const MAX_STDOUT_CHARS = 4000;
const SKILL_MD = [".claude", "skills", "gt-test-case-generator", "SKILL.md"];
const CRITERIA_HEADING = "## Acceptance criteria (LLM-reviewed)";

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["PASS", "FAIL"] },
    notes: { type: "array", items: { type: "string" } },
  },
  required: ["verdict", "notes"],
  additionalProperties: false,
};

const PREAMBLE = `You are an independent reviewer. You did NOT write this output: a deterministic script
(gt-test-case-generator) just converted test-ideas.json scenarios into tracker test cases, writing one
tc-N.json registration record and one tc-steps-N.md steps table per scenario index N.

Judge that output only against the acceptance criteria below. Be critical by default: assume something
is wrong until you have checked every criterion for every in-scope index explicitly. Compare strings
character by character — "verbatim" means exactly equal, not "same meaning".

Return FAIL only for a concrete criterion violation you can point to — never for style, wording, or
test-design preferences. One note per violation, naming the file and field (or step), quoting the actual
value, and ending with the expected value, formatted:
  tc-N.json.<field>: <problem, quoting the actual value> (criterion n) → expected <correct value>
  tc-steps-N.md step k: <problem, quoting the actual value> (criterion n) → expected <correct value>
  tc-N.json: missing (criterion 1) → expected a registration record for scenario index N
Never suggest editing the files by hand: the author fixes an index only by deleting its tc-N files and
re-running the script. verdict = PASS only if every criterion holds; then notes = [].`;

/**
 * @param {{ projectDir: string, runDir: string, ideas: unknown[], indices: number[], command: string, stdout: string, model?: string }} args
 *        runDir = absolute run folder; ideas = parsed test-ideas.json; indices = in-scope scenario indices
 * @returns {Promise<{ verdict: "PASS"|"FAIL", notes: string[] } | { error: string }>}
 *          `error` = the reviewer itself could not run (setup, auth, timeout, bad output) — not a verdict.
 */
export async function reviewTcWithLlm({ projectDir, runDir, ideas, indices, command, stdout, model = DEFAULT_MODEL }) {
  let sdk;
  let criteria;
  try {
    const require = createRequire(join(projectDir, "package.json"));
    sdk = await import(pathToFileURL(require.resolve("@anthropic-ai/claude-agent-sdk")).href);
    criteria = loadCriteria(projectDir);
  } catch (e) {
    return { error: `llm setup failed: ${e.message}` };
  }

  const prompt = buildPrompt({ projectDir, runDir, ideas, indices, command, stdout });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const stream = sdk.query({
      prompt,
      options: {
        cwd: projectDir,
        systemPrompt: `${PREAMBLE}\n\n${criteria}`,
        model,
        tools: [],
        settingSources: [],
        maxTurns: 3,
        persistSession: false,
        abortController: controller,
        outputFormat: { type: "json_schema", schema: OUTPUT_SCHEMA },
        env: { ...process.env, TC_GATE_CHILD: "1" },
      },
    });
    for await (const msg of stream) {
      if (msg.type !== "result") continue;
      if (msg.subtype !== "success" || msg.is_error) {
        const why = msg.is_error && msg.subtype === "success" ? "llm returned an error" : `llm ended with ${msg.subtype}`;
        return { error: `${why}${msg.result ? `: ${msg.result}` : ""}` };
      }
      const out = msg.structured_output;
      if (out && (out.verdict === "PASS" || out.verdict === "FAIL") && Array.isArray(out.notes)) {
        return { verdict: out.verdict, notes: out.notes.map(String) };
      }
      return { error: `llm returned no structured verdict: ${String(msg.result).slice(0, 300)}` };
    }
    return { error: "llm stream ended without a result" };
  } catch (e) {
    return { error: controller.signal.aborted ? `llm timed out after ${TIMEOUT_MS / 1000}s` : `llm failed: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * sha256 of everything the verdict depends on: model, reviewer rules, and the pasted files (buildEvidence).
 * The command and its stdout are left out — they are context, and differ between re-runs of the same script on
 * the same files. Equal digest = the reviewer would be shown the same evidence, so tc-gate reuses the last verdict.
 * @returns {string|null} null when the rules cannot be loaded (the review itself will then report the error)
 */
export function reviewDigest({ projectDir, runDir, ideas, indices, model = DEFAULT_MODEL }) {
  try {
    const evidence = buildEvidence({ runDir, ideas, indices });
    const scope = [toRel(projectDir, runDir), compactRange(indices), ideas.length];
    return createHash("sha256").update(JSON.stringify([model, PREAMBLE, loadCriteria(projectDir), scope, evidence])).digest("hex");
  } catch {
    return null;
  }
}

const fence = (lang, text) => ["```" + lang, text, "```"].join("\n");

/** Everything the reviewer needs, pasted in — it has no tools. */
function buildPrompt({ projectDir, runDir, ideas, indices, command, stdout }) {
  const out = String(stdout ?? "");
  return [
    `Review the gt-test-case-generator output in run folder ${toRel(projectDir, runDir)}. You have no tools — everything is pasted below.`,
    `In-scope scenario indices: ${compactRange(indices)} (test-ideas.json has ${ideas.length} units).`,
    ``,
    `## Script command that just ran`,
    fence("bash", command.trim()),
    `stdout${out.length > MAX_STDOUT_CHARS ? ` (first ${MAX_STDOUT_CHARS} chars)` : ""}:`,
    fence("", out.slice(0, MAX_STDOUT_CHARS).trimEnd() || "(empty)"),
    ``,
    buildEvidence({ runDir, ideas, indices }),
  ].join("\n");
}

/** The file-derived part of the prompt (all the verdict depends on, besides the rules). */
function buildEvidence({ runDir, ideas, indices }) {
  const scope = new Set(indices);

  const us = parseJson(readOrNull(join(runDir, "us.json")));
  const usPart = us && typeof us === "object" ? fence("json", JSON.stringify({ id: us.id }, null, 2)) : "(us.json not found or not valid JSON)";

  const units = indices.map((i) => {
    const u = ideas[i] ?? {};
    return { index: i, scenario: u.scenario, ideas: u.ideas, verifications: u.verifications };
  });

  const recon = parseJson(readOrNull(join(runDir, "reconciliation.json")));
  let reconPart;
  if (!recon) reconPart = "reconciliation.json: absent → every in-scope index is action \"create\" (reused must be false).";
  else if (!Array.isArray(recon.scenario_matches)) {
    reconPart = `reconciliation.json: present, status ${JSON.stringify(recon.status ?? null)}, no scenario_matches → every in-scope index is action "create" (reused must be false).`;
  } else {
    const matches = recon.scenario_matches.filter((m) => scope.has(m?.scenario_index));
    reconPart = `reconciliation.json scenario_matches (in-scope indices only):\n${fence("json", JSON.stringify(matches, null, 2))}`;
  }

  let present = [];
  try {
    present = readdirSync(runDir).filter((f) => /^tc-/.test(f)).sort(naturalSort);
  } catch {
    /* listed as empty */
  }

  const perIndex = indices.map((i) => {
    const tc = readOrNull(join(runDir, `tc-${i}.json`));
    const md = readOrNull(join(runDir, `tc-steps-${i}.md`));
    return [
      `### index ${i}`,
      `tc-${i}.json:`,
      tc === null ? "(missing)" : fence("json", tc.trim()),
      `tc-steps-${i}.md:`,
      md === null ? "(missing)" : fence("markdown", md.trimEnd()),
    ].join("\n");
  });

  return [
    `## Files present in the run folder (tc-*)`,
    present.length ? present.join("\n") : "(none)",
    ``,
    `## us.json (id only)`,
    usPart,
    ``,
    `## test-ideas.json — in-scope units (index, scenario, ideas, verifications only)`,
    fence("json", JSON.stringify(units, null, 2)),
    ``,
    `## Reconciliation`,
    reconPart,
    ``,
    `## Output under review (tc-steps-N.xml omitted — generated from the same values in the same loop)`,
    ...perIndex,
  ].join("\n");
}

/** The "## Acceptance criteria (LLM-reviewed)" section of the skill's SKILL.md, up to the next "## " heading. */
function loadCriteria(projectDir) {
  const raw = readFileSync(join(projectDir, ...SKILL_MD), "utf8").replace(/\r\n/g, "\n");
  const start = raw.indexOf(`\n${CRITERIA_HEADING}`);
  if (start < 0) throw new Error(`"${CRITERIA_HEADING}" not found in ${SKILL_MD.join("/")}`);
  const body = raw.slice(start + 1);
  const end = body.indexOf("\n## ", CRITERIA_HEADING.length);
  return (end < 0 ? body : body.slice(0, end)).trim();
}

function compactRange(nums) {
  if (!nums.length) return "(none)";
  const sorted = [...nums].sort((a, b) => a - b);
  const contiguous = sorted.every((n, k) => k === 0 || n === sorted[k - 1] + 1);
  return contiguous && sorted.length > 2 ? `${sorted[0]}–${sorted.at(-1)}` : sorted.join(", ");
}

function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true });
}

function toRel(projectDir, p) {
  return relative(projectDir, p).split("\\").join("/");
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
