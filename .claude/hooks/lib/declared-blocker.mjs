// "BLOCKED: <reason>" convention shared by the stop-style gates (us-json-gate.mjs, artifact-gate.mjs --trigger stop).
//
// An agent that cannot fix its artifact (empty story, wrong upstream input, denied tool) ends its final message with a
// line starting "BLOCKED: <reason>". The gate then records FAILED (with `blocked`) and allows the stop at once instead
// of burning its retries on feedback nobody can act on. A declared blocker can never turn a failure into a pass.

/**
 * @param {{ last_assistant_message?: string }} input  Stop / SubagentStop hook input
 * @param {object[]} transcript  parsed transcript entries — fallback when last_assistant_message is absent
 * @returns {string|null} the first "BLOCKED: …" line (markdown stripped, ≤ 500 chars), or null
 */
export function declaredBlocker(input, transcript) {
  const text = typeof input?.last_assistant_message === "string" ? input.last_assistant_message : lastAssistantText(transcript);
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.replace(/^[\s>*_`#-]+/, "").replace(/[*_`]+/g, "").trim();
    if (/^BLOCKED:\s*\S/i.test(line)) return line.slice(0, 500);
  }
  return null;
}

/** Text of the last assistant message in a transcript (entries from the .jsonl file). */
export function lastAssistantText(transcript) {
  for (let i = (transcript?.length ?? 0) - 1; i >= 0; i--) {
    const e = transcript[i];
    if (e?.type !== "assistant") continue;
    const content = e.message?.content;
    if (typeof content === "string") return content;
    const text = Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "";
    if (text) return text;
  }
  return "";
}
