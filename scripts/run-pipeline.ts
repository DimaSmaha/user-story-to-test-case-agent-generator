import { query } from "@anthropic-ai/claude-agent-sdk";
import * as path from "path";
import { getEnvVars } from "../helpers/getEnvVars";
import {
  c,
  printBanner,
  printToolUse,
  printFinalSummary,
  scanTextBlock,
  type PhaseCompact,
} from "./utils/colors";

const PROJECT_ROOT = path.resolve(__dirname, "..");
const MAX_TURNS = Number(process.env["MAX_PIPELINE_TURNS"] ?? 120);

async function main(): Promise<void> {
  const usId = process.argv[2];
  if (!usId) {
    console.error(`${c.red}[ERROR] Story ID is required.${c.reset}`);
    console.error(`\nUsage:  npm run us:to:tc <story-id>`);
    console.error(`Example: npm run us:to:tc 112\n`);
    process.exit(1);
  }

  if (!/^\d+$/.test(usId)) {
    console.warn(
      `${c.yellow}[WARN] Story ID "${usId}" is not numeric — proceeding anyway${c.reset}`,
    );
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
        maxTurns: MAX_TURNS,
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
            } else if (b["type"] === "tool_use" && typeof b["name"] === "string") {
              printToolUse(b["name"], (b["input"] as Record<string, unknown>) ?? {});
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
          printFinalSummary(phaseCompacts, r.total_cost_usd, r.duration_ms, r.num_turns, sessionId);
        } else {
          console.error(`\n${c.red}${c.bold}[PIPELINE ERROR] ${r.subtype}${c.reset}`);
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
