import { query } from "@anthropic-ai/claude-agent-sdk";
import * as path from "path";
import { getEnvVars } from "../helpers/getEnvVars";

const PROJECT_ROOT = path.resolve(__dirname, "..");

// ─── ANSI colours (no chalk dep) ─────────────────────────────────────────────
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
};

// ─── Types ────────────────────────────────────────────────────────────────────
interface PhaseCompact {
  phase: string;
  scenario_index?: number;
  status: "SUCCESS" | "FAILED" | "SKIPPED";
  [key: string]: unknown;
}

// Regex that matches <!-- PHASE COMPACT: label --> followed by a JSON block
const PHASE_COMPACT_RE =
  /<!--\s*PHASE COMPACT:\s*([^\s>\-][^>]*?)-->\s*(\{[\s\S]*?\n\})/g;

// ─── Logging helpers ──────────────────────────────────────────────────────────
function printBanner(title: string, color: string = c.cyan): void {
  const line = "═".repeat(62);
  console.log(`\n${color}${c.bold}${line}${c.reset}`);
  console.log(`${color}${c.bold}  ${title}${c.reset}`);
  console.log(`${color}${c.bold}${line}${c.reset}`);
}

function printPhaseCompact(compact: PhaseCompact): void {
  const statusColor =
    compact.status === "SUCCESS"
      ? c.green
      : compact.status === "SKIPPED"
        ? c.yellow
        : c.red;
  const label =
    compact.scenario_index !== undefined
      ? `${compact.phase} [scenario ${compact.scenario_index}]`
      : compact.phase;
  console.log(`\n${c.magenta}${c.bold}┌─ PHASE COMPACT: ${label}${c.reset}`);
  console.log(
    `${c.magenta}│${c.reset}  status: ${statusColor}${c.bold}${compact.status}${c.reset}`,
  );
  for (const [k, v] of Object.entries(compact)) {
    if (k === "phase" || k === "status" || k === "scenario_index") continue;
    const val = typeof v === "object" ? JSON.stringify(v) : String(v);
    console.log(`${c.magenta}│${c.reset}  ${k}: ${c.cyan}${val}${c.reset}`);
  }
  console.log(`${c.magenta}└${"─".repeat(42)}${c.reset}`);
}

function printToolUse(name: string, input: Record<string, unknown>): void {
  let detail = "";
  if (typeof input["command"] === "string")
    detail = input["command"].slice(0, 120);
  else if (typeof input["file_path"] === "string") detail = input["file_path"];
  else if (typeof input["pattern"] === "string") detail = input["pattern"];
  else if (typeof input["url"] === "string") detail = input["url"];
  else if (typeof input["prompt"] === "string")
    detail = (input["prompt"] as string).slice(0, 80);
  else detail = JSON.stringify(input).slice(0, 80);
  console.log(
    `  ${c.yellow}[TOOL]${c.reset} ${c.bold}${name}${c.reset} ${c.dim}${detail}${c.reset}`,
  );
}

function printFinalSummary(
  phaseCompacts: PhaseCompact[],
  totalCostUsd: number,
  durationMs: number,
  numTurns: number,
  sessionId: string,
): void {
  printBanner("PIPELINE COMPLETE", c.green);

  console.log(`\n${c.bold}Session:${c.reset}  ${sessionId}`);
  console.log(
    `${c.bold}Turns:${c.reset}    ${numTurns}  │  ` +
      `${c.bold}Duration:${c.reset} ${(durationMs / 1000).toFixed(1)}s  │  ` +
      `${c.bold}Cost:${c.reset} $${totalCostUsd.toFixed(4)}`,
  );

  if (phaseCompacts.length > 0) {
    console.log(`\n${c.bold}Phase results:${c.reset}`);
    for (const p of phaseCompacts) {
      const col =
        p.status === "SUCCESS"
          ? c.green
          : p.status === "SKIPPED"
            ? c.yellow
            : c.red;
      const label =
        p.scenario_index !== undefined
          ? `${p.phase} [s${p.scenario_index}]`
          : p.phase;
      console.log(`  ${label.padEnd(44)} ${col}${p.status}${c.reset}`);
    }
  }

  const tcCount = phaseCompacts.filter(
    (p) => p.phase === "gt-test-case-generator" && p.status === "SUCCESS",
  ).length;
  const explorationBlock = phaseCompacts.find(
    (p) =>
      p.phase === "App exploration" ||
      p.phase.includes("1.5") ||
      p.phase.includes("exploration"),
  );
  const bugCount = explorationBlock
    ? Number(explorationBlock["bug_count"] ?? 0)
    : 0;
  const linkBlock = phaseCompacts.find(
    (p) => p.phase.toLowerCase().includes("link") || p.phase.includes("4"),
  );
  const linkedCount = linkBlock ? Number(linkBlock["linked_count"] ?? 0) : 0;

  console.log(`\n${c.bold}Totals:${c.reset}`);
  console.log(`  Test cases generated: ${c.cyan}${tcCount}${c.reset}`);
  console.log(`  TCs linked to story:  ${c.cyan}${linkedCount}${c.reset}`);
  console.log(
    `  Exploration bugs:     ${bugCount > 0 ? c.red : c.dim}${bugCount}${c.reset}`,
  );
  console.log();
}

// ─── Text scanner ─────────────────────────────────────────────────────────────
function scanTextBlock(
  text: string,
  textBuffer: string[],
  phaseCompacts: PhaseCompact[],
): string {
  // Print text with highlights
  const trimmed = text.replace(/\n{3,}/g, "\n\n").trim();
  if (trimmed) {
    for (const line of trimmed.split("\n")) {
      if (line.startsWith("✓") || line.startsWith("+ ")) {
        console.log(`  ${c.green}${line}${c.reset}`);
      } else if (/^#{1,3}\s/.test(line) || /^Phase\s/i.test(line)) {
        console.log(`  ${c.cyan}${c.bold}${line}${c.reset}`);
      } else {
        console.log(`  ${line}`);
      }
    }
  }

  // Maintain a rolling buffer for cross-message phase compact detection
  const buffer = (textBuffer.join("") + text).slice(-3000);
  textBuffer.length = 0;
  textBuffer.push(buffer);

  PHASE_COMPACT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PHASE_COMPACT_RE.exec(buffer)) !== null) {
    try {
      const compact = JSON.parse(match[2]!) as PhaseCompact;
      if (!compact.phase) compact.phase = match[1]!.trim();
      // Avoid duplicates
      const isDupe = phaseCompacts.some(
        (p) =>
          p.phase === compact.phase &&
          p.scenario_index === compact.scenario_index &&
          p.status === compact.status,
      );
      if (!isDupe) {
        phaseCompacts.push(compact);
        printPhaseCompact(compact);
      }
    } catch {
      // Not valid JSON — skip
    }
  }

  return buffer;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const usId = process.argv[2];
  if (!usId) {
    console.error(`${c.red}[ERROR] Story ID is required.${c.reset}`);
    console.error(`\nUsage:  npm run us:to:tc <story-id>`);
    console.error(`Example: npm run us:to:tc 112\n`);
    process.exit(1);
  }

  let envVars;
  try {
    envVars = getEnvVars();
  } catch (err: unknown) {
    console.error(`${c.red}[ERROR] ${(err as Error).message}${c.reset}`);
    process.exit(1);
  }

  const controller = new AbortController();
  process.on("SIGINT", () => {
    console.log(`\n${c.yellow}[INTERRUPTED] Aborting pipeline...${c.reset}`);
    controller.abort();
  });

  printBanner(`/flow-1a-gt-us-to-tc  --us-id ${usId}`);
  console.log(`${c.dim}Tracker: ${envVars.ISSUE_TRACKER}${c.reset}\n`);

  const phaseCompacts: PhaseCompact[] = [];
  const textBuffer: string[] = [];
  let sessionId = "";
  let model = "";

  try {
    const stream = query({
      prompt: `/flow-1a-gt-us-to-tc --us-id ${usId}`,
      options: {
        cwd: PROJECT_ROOT,
        settingSources: ["user", "project"],
        skills: "all",
        permissionMode: "bypassPermissions",
        maxTurns: 120,
        abortController: controller,
        env: {
          ISSUE_TRACKER: envVars.ISSUE_TRACKER,
          FAKE_TRACKER_URL: envVars.FAKE_TRACKER_URL,
        },
      },
    });

    for await (const message of stream) {
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
        model = message.model;
        const skills: string[] =
          (message as unknown as { skills?: string[] }).skills ?? [];
        console.log(`${c.dim}Session: ${sessionId}${c.reset}`);
        console.log(`${c.dim}Model:   ${model}${c.reset}`);
        if (skills.length > 0) {
          console.log(`${c.dim}Skills:  ${skills.join(", ")}${c.reset}`);
        }
        console.log();
      } else if (message.type === "assistant") {
        const content = message.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as unknown as Record<string, unknown>;
            if (b["type"] === "text" && typeof b["text"] === "string") {
              scanTextBlock(b["text"], textBuffer, phaseCompacts);
            } else if (
              b["type"] === "tool_use" &&
              typeof b["name"] === "string"
            ) {
              printToolUse(
                b["name"],
                (b["input"] as Record<string, unknown>) ?? {},
              );
            }
          }
        }
      } else if (message.type === "result") {
        const r = message as unknown as {
          subtype: string;
          total_cost_usd: number;
          duration_ms: number;
          num_turns: number;
          result?: string;
          errors?: string[];
        };
        if (r.subtype === "success") {
          printFinalSummary(
            phaseCompacts,
            r.total_cost_usd,
            r.duration_ms,
            r.num_turns,
            sessionId,
          );
        } else {
          console.error(
            `\n${c.red}${c.bold}[PIPELINE ERROR] ${r.subtype}${c.reset}`,
          );
          if (Array.isArray(r.errors)) {
            for (const e of r.errors) console.error(`  ${c.red}${e}${c.reset}`);
          }
          process.exit(2);
        }
      }
    }
  } catch (err: unknown) {
    const e = err as Error;
    if (e.name === "AbortError" || e.message?.includes("aborted")) {
      console.log(`\n${c.yellow}Pipeline aborted.${c.reset}`);
      process.exit(130);
    }
    console.error(`\n${c.red}${c.bold}[FATAL]${c.reset}`, e.message ?? e);
    process.exit(3);
  }
}

main();
