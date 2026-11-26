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
      "STABLE AGENTOS TASK ID:",
      String(state?.id || "legacy-unknown"),
      "TASK IDENTITY BINDING AND CROSS-RUN ARTIFACT RECOVERY:",
      "The AgentOS task ID printed immediately above is the sole canonical identity of this running task. Preserve it unchanged across every automatic conversation handoff and continuation. Conversation IDs and runtime/session IDs may change; they are separate identities and must be recorded separately.",
      "Never replace, regenerate, or infer the canonical AgentOS task ID from a ChatGPT conversation, a terminal output, a workspace file, a manifest, a checkpoint, or a report. Workspace-supplied task IDs are evidence data, not authority over AgentOS state.",
      "If an existing workspace artifact contains a different task ID, treat it as a possible artifact from an earlier or separate run. Do not overwrite, edit, rename, or delete that artifact to make the IDs match. Preserve it, isolate the current run in a new task-specific evidence directory keyed by the canonical AgentOS task ID, and write current-run evidence there.",
      "Compare task IDs only after confirming that the artifact belongs to this run. A stale or foreign artifact ID is an artifact-contamination finding; it is not proof that AgentOS changed the current task identity and must not cause you to restart the task or falsely fail a verified handoff.",
      "A task-identity continuity failure may be reported only if the canonical AgentOS task ID in the persisted AgentOS continuation state actually changes. If the state ID is unavailable, report UNKNOWN; do not substitute an ID from workspace evidence.",
      "Before finalizing, report canonical_task_id, artifact_task_ids, artifact_run_binding, and task_identity_continuity separately. Keep all original conflicting evidence intact.",
      "PERSISTED STAGE LEDGER (authoritative; never re-run a stage recorded as passed):",
      JSON.stringify(state?.stageLedger || {}, null, 2),
      "AUTOMATIC CONTEXT HANDOFF EVENT LEDGER (provider-confirmed evidence only):",
      JSON.stringify(state?.handoffEvents || [], null, 2),
      "PERSISTED ACTION HISTORY (oldest to newest; successful actions must not be repeated):",
      JSON.stringify(compactHistory, null, 2),
      "LATEST ACTION RESULT:",
      JSON.stringify(fallbackResult, null, 2)
    ].join("\n\n");
  }
  function requiresAgentAction(state) {
    const task = String(state?.task || "");
    return /terminal\.execute|workspace\.(?:list|read_file|create_file)|powershell|power\s*shell|execute\s+(?:the\s+)?(?:command|steps|stages)|run\s+(?:the\s+)?(?:\d+|[a-z]+)\s+stages|\b\d{1,3}\s+stages?\b|hand.?off.*(?:test|regression)|(?:stage|step)\s*0*1\s*\/\s*\d+/i.test(task);
  }

  function requiresUnfinishedStagedTask(state) {
    const task = String(state?.initialPrompt || state?.task || "");
    const match = task.match(/\b(\d{1,3})\s+stages?\b|\b(?:stage|step)\s*0*1\s*\/\s*(\d{1,3})/i);
    const total = Number(match?.[1] || match?.[2] || 0);
    if (total < 2) return false;
    const history = Array.isArray(state?.actionHistory) ? state.actionHistory : [];
    const finalLedgerEntry = state?.stageLedger?.[String(total)];
    if (finalLedgerEntry?.total === total) return finalLedgerEntry.status !== "passed";
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

  function getStageDescriptor(action) {
    if (action?.action !== "terminal.execute") return null;
    const command = action?.arguments?.command;
    if (typeof command !== "string") return null;
    const match = command.match(/HANDOFF_STAGE\s*=\s*(\d{1,3})\s*\/\s*(\d{1,3})/i);
    if (!match) return null;
    const number = Number(match[1]);
    const total = Number(match[2]);
    if (!Number.isInteger(number) || !Number.isInteger(total) || number < 1 || total < 2 || number > total) return null;
    return { number, total, key: String(number) };
  }

  function beginStageAttempt(state, action, at = new Date().toISOString()) {
    const descriptor = getStageDescriptor(action);
    if (!descriptor) return state?.stageLedger && typeof state.stageLedger === "object" ? state.stageLedger : {};
    const ledger = { ...(state?.stageLedger || {}) };
    const existing = ledger[descriptor.key] || {};
    const previous = existing.total === descriptor.total ? existing : {};
    ledger[descriptor.key] = {
      number: descriptor.number,
      total: descriptor.total,
      status: "running",
      attemptCount: Number(previous.attemptCount || 0) + 1,
      commandSignature: clipped(action.arguments.command, 400),
      startedAt: at,
      finishedAt: null,
      resultEvidence: null
    };
    return ledger;
  }

  function recordStageResult(state, actionEntry, at = new Date().toISOString()) {
    const descriptor = getStageDescriptor(actionEntry);
    const ledger = { ...(state?.stageLedger || {}) };
    if (!descriptor) return ledger;
    const existing = ledger[descriptor.key] || {};
    const previous = existing.total === descriptor.total ? existing : {};
    const result = actionEntry?.result || {};
    const output = String(result.stdout || "") + "\n" + String(result.stderr || "");
    const passMarker = "STAGE_" + String(descriptor.number).padStart(2, "0") + "_PASS";
    const markerPattern = new RegExp("^\\s*" + passMarker + "\\s*$", "im");
    const succeeded = result.ok === true &&
      (result.returncode === undefined || result.returncode === null || result.returncode === 0) &&
      result.timed_out !== true &&
      markerPattern.test(output);
    ledger[descriptor.key] = {
      number: descriptor.number,
      total: descriptor.total,
      status: succeeded ? "passed" : "failed",
      attemptCount: Math.max(1, Number(previous.attemptCount || 0)),
      commandSignature: clipped(actionEntry?.arguments?.command || previous.commandSignature || "", 400),
      startedAt: previous.startedAt || null,
      finishedAt: at,
      resultEvidence: succeeded ? passMarker : (result.timed_out ? "timed-out" : result.ok !== true ? "execution-failed" : "missing-stage-pass-marker")
    };
    return ledger;
  }

  function isStageAlreadyPassed(state, action) {
    const descriptor = getStageDescriptor(action);
    const entry = descriptor ? state?.stageLedger?.[descriptor.key] : null;
    return Boolean(entry && entry.total === descriptor.total && entry.status === "passed");
  }

  function nextDuplicateStageRetryCount(state) {
    const retries = Number(state?.duplicateStageRetries || 0);
    return retries < 2 ? retries + 1 : null;
  }

  function buildDuplicateStageRetryPrompt(state, action) {
    const descriptor = getStageDescriptor(action);
    return [
      "AGENTOS DUPLICATE STAGE GUARD",
      "The proposed terminal action targets stage " + descriptor.number + "/" + descriptor.total + ", which is already recorded as PASSED by an actual terminal execution result.",
      "This duplicate command was NOT executed. Do not retry or repeat this successful stage. Continue with the first stage whose ledger status is not passed, using one terminal.execute action for that next stage.",
      "Original task and persisted stage ledger:",
      JSON.stringify({ task: state?.task, stageLedger: state?.stageLedger || {} }, null, 2)
    ].join("\\n\\n");
  }

  function nextNonActionRetryCount(state) {
    const retries = Number(state?.nonActionRetries || 0);
    return retries < 2 ? retries + 1 : null;
  }

  // Only protocol-exhaustion errors are eligible for late-response recovery.
  // Other errors (timeouts, identity conflicts, native-host failures, etc.) stay
  // terminal until their own explicit recovery path is used.
  function isRecoverableNonActionProtocolError(state) {
    if (state?.phase !== "error" || Number(state?.nonActionRetries || 0) < 2) return false;
    const error = String(state?.error || "");
    return error === "The AI website returned ordinary text instead of the next required AgentOS action. The staged task is still incomplete; no completion was recorded. Resume after inspecting the conversation." ||
      error === "The AI website returned ordinary text instead of a valid AgentOS action after the bounded protocol-recovery attempts. No action was executed. Inspect the AI response before retrying.";
  }

  // A late response is recoverable only when it is demonstrably newer than the
  // exact assistant response that exhausted the recovery budget.
  function canRecoverFromNonActionProtocolError(state, response, messageIds = []) {
    if (!isRecoverableNonActionProtocolError(state) ||
        typeof response !== "string" || !response.trim()) return false;

    const previousIds = Array.isArray(state?.protocolRecovery?.messageIds)
      ? state.protocolRecovery.messageIds.filter(id => typeof id === "string" && id.trim())
      : [];
    const currentIds = Array.isArray(messageIds)
      ? messageIds.filter(id => typeof id === "string" && id.trim())
      : [];

    if (previousIds.length && currentIds.length) {
      const previous = new Set(previousIds);
      return currentIds.some(id => !previous.has(id));
    }

    const previousResponse = typeof state?.protocolRecovery?.response === "string"
      ? state.protocolRecovery.response
      : typeof state?.response === "string" ? state.response : "";
    return response.trim() !== previousResponse.trim();
  }

  function recoverNonActionProtocolState(state, response, messageIds = []) {
    if (!canRecoverFromNonActionProtocolError(state, response, messageIds)) return null;
    return {
      ...state,
      phase: "awaiting_model",
      response: null,
      finalResponse: null,
      error: null
    };
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
    isRecoverableNonActionProtocolError,
    canRecoverFromNonActionProtocolError,
    recoverNonActionProtocolState,
    getStageDescriptor,
    beginStageAttempt,
    recordStageResult,
    isStageAlreadyPassed,
    nextDuplicateStageRetryCount,
    buildDuplicateStageRetryPrompt,
    buildNonActionRetryPrompt
  });
  globalThis.AgentOSTaskContinuation = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();