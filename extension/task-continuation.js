(() => {
  "use strict";
  const MAX_HISTORY_ITEMS = 40;
  function clipped(value, limit) {
    const text = String(value ?? "");
    return text.length > limit ? text.slice(0, limit) + "…[truncated]" : text;
  }
  function compactAction(entry, index) {
    const args = entry?.arguments && typeof entry.arguments === "object" ? entry.arguments : {};
    const result = entry?.result && typeof entry.result === "object" ? entry.result : entry || {};
    const compactArguments = {};
    for (const key of ["command", "cwd", "path", "name", "server", "tool"]) {
      if (typeof args[key] === "string") compactArguments[key] = clipped(args[key], key === "command" ? 260 : 120);
    }
    if (typeof args.content === "string") compactArguments.content_length = args.content.length;
    return {
      step: index + 1,
      action: clipped(entry?.action || result.action || "unknown", 80),
      arguments: compactArguments,
      result: {
        ok: result.ok === true,
        rejected: result.rejected === true,
        returncode: result.returncode ?? null,
        timed_out: result.timed_out === true,
        stdout: clipped(result.stdout || "", 320),
        stderr: clipped(result.stderr || "", 140),
        error: clipped(result.error || result.reason || "", 180)
      }
    };
  }
  function buildContinuationPrompt(state, latestResult = null) {
    const originalPrompt =
      typeof state?.initialPrompt === "string" && state.initialPrompt.trim()
        ? state.initialPrompt
        : typeof state?.task === "string" ? state.task : "";
    let history = Array.isArray(state?.actionHistory) ? state.actionHistory.slice(-MAX_HISTORY_ITEMS) : [];
    if (latestResult) {
      const latest = history[history.length - 1];
      if (latest !== latestResult && JSON.stringify(latest || null) !== JSON.stringify(latestResult)) {
        history = [...history, latestResult].slice(-MAX_HISTORY_ITEMS);
      }
    }
    const compactHistory = history.map(compactAction);
    const fallbackResult = latestResult ? compactAction(latestResult, compactHistory.length) : null;
    return [
      "AGENTOS TASK CONTINUATION — SAME TASK, POSSIBLY NEW CONVERSATION",
      "This message may be delivered in a brand-new AI conversation after an automatic ChatGPT context handoff. Do not rely on any messages from the previous conversation. The original prompt and execution ledger below are the authoritative task state.",
      "Follow the complete AgentOS operating instructions included in the original initial prompt. They are repeated here because a new conversation does not inherit the previous conversation's instructions.",
      "Continue the SAME original task. Do not restart it, do not repeat any successful action, and do not declare completion merely because the conversation changed.",
      "When another action is required, emit exactly ONE fenced json block and no surrounding prose, using this exact envelope: {\"protocol\":\"agentos.v1\",\"type\":\"action\",\"action\":\"ACTION_NAME\",\"arguments\":{}}.",
      "Supported actions: runtime.status, skills.list, plugins.list, mcp.list, mcp.tools, mcp.call, skills.read, plugins.call, workspace.list, workspace.read_file, workspace.create_file, browser.open_url, terminal.execute.",
      "Use the completed action history to identify the next unfinished part of the original request. For numbered or staged tasks, continue with the first stage that has not succeeded. A successful action must never be repeated.",
      "Only provide a normal final prose answer after every requirement in the original task has actually been completed. If more work remains, emit the next single action envelope.",
      "ORIGINAL INITIAL PROMPT (complete AgentOS instructions, workspace details, and user task):",
      originalPrompt,
      "PERSISTED ACTION HISTORY (oldest to newest; successful actions must not be repeated):",
      JSON.stringify(compactHistory, null, 2),
      "LATEST ACTION RESULT:",
      JSON.stringify(fallbackResult, null, 2)
    ].join("\n\n");
  }
  function requiresAgentAction(state) {
    const task = String(state?.task || "");
    return /terminal\.execute|workspace\.(?:list|read_file|create_file)|powershell|power\s*shell|execute\s+(?:the\s+)?(?:command|steps|stages)|run\s+(?:the\s+)?(?:\d+|[a-z]+)\s+stages|\\b\\d{1,3}\\s+stages?\\b|hand.?off.*(?:test|regression)|(?:stage|step)\s*0*1\s*\/\s*\d+/i.test(task);
  }

  function requiresUnfinishedStagedTask(state) {
    const task = String(state?.initialPrompt || state?.task || "");
    const match = task.match(/\b(\d{1,3})\s+stages?\b|\b(?:stage|step)\s*0*1\s*\/\s*(\d{1,3})/i);
    const total = Number(match?.[1] || match?.[2] || 0);
    if (total < 2) return false;
    const history = Array.isArray(state?.actionHistory) ? state.actionHistory : [];
    const finalMarker = "HANDOFF_STAGE=" + String(total).padStart(2, "0") + "/" + total;
    const finalPass = "STAGE_" + String(total).padStart(2, "0") + "_PASS";
    return !history.some(entry => {
      const args = entry?.arguments || {};
      const result = entry?.result || {};
      const command = String(args.command || "");
      const output = String(result.stdout || "") + "\n" + String(result.stderr || "");
      return result.ok === true && command.includes(finalMarker) && output.includes(finalPass);
    });
  }

  function nextNonActionRetryCount(state) {
    const retries = Number(state?.nonActionRetries || 0);
    return retries < 2 ? retries + 1 : null;
  }

  function buildNonActionRetryPrompt(state, previousResponse) {
    const prior = clipped(previousResponse, 1200);
    return [
      "AGENTOS ACTION PROTOCOL RECOVERY",
      "Your previous response did not contain a valid AgentOS action envelope. That response executed no action. Earlier successful actions, if any, remain recorded in the persisted action history below. Do not claim that the task is complete and do not provide a plan or ordinary prose.",
      "Re-read the complete original AgentOS instructions and execution ledger. Continue the SAME task from the first stage or requirement that has not succeeded. Never repeat a successful action. Emit exactly ONE valid fenced JSON action envelope for the next required action; do not combine multiple stages in one command.",
      "The next message must contain the action envelope only.",
      buildContinuationPrompt(state),
      "PREVIOUS NON-ACTION RESPONSE (for diagnosis only; it was not executed):",
      prior
    ].join("\n\n");
  }

  const api = Object.freeze({
    buildContinuationPrompt,
    requiresAgentAction,
    requiresUnfinishedStagedTask,
    nextNonActionRetryCount,
    buildNonActionRetryPrompt
  });
  globalThis.AgentOSTaskContinuation = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();