const api = globalThis.browser;
const conversationIdentity = globalThis.AgentOSConversationIdentity;
if (!conversationIdentity) {
  throw new Error("AgentOS conversation identity helpers were not loaded.");
}
const {
  chatGPTConversationIdentityMatches,
  sameConversation,
  isVerifiedChatGPTContinuation,
  applyChatGPTHandoff
} = conversationIdentity;
const taskContinuation = globalThis.AgentOSTaskContinuation;
if (!taskContinuation) {
  throw new Error("AgentOS task continuation helpers were not loaded.");
}
const {
  buildTaskRunContext,
  buildInitialTaskPrompt,
  buildContinuationPrompt,
  requiresAgentAction,
  requiresUnfinishedStagedTask,
  nextNonActionRetryCount,
  isRecoverableNonActionProtocolError,
  recoverNonActionProtocolState,
  beginStageAttempt,
  recordStageResult,
  isStageAlreadyPassed,
  nextDuplicateStageRetryCount,
  buildDuplicateStageRetryPrompt,
  buildNonActionRetryPrompt
} = taskContinuation;

const TASK_STATE_KEY = "agentos.taskState";
const TASKS_KEY = "agentos.tasks";
const ACTIVE_TASK_KEY = "agentos.activeTaskId";
const STOP_KEY = "agentos.stopped";
const MAX_STEPS = 40;
const RESPONSE_TIMEOUT_MINUTES = 8;
let terminalInvocationSequence = 0;
const AUTONOMOUS_ACTIONS = new Set([
  // Read-only discovery plus workspace-scoped project actions can run without
  // per-step approval. External plugin/MCP calls and browser navigation remain supervised.
  "runtime.status", "skills.list", "skills.read", "plugins.list",
  "mcp.list", "mcp.tools", "workspace.list", "workspace.read_file",
  "workspace.create_file", "terminal.execute"
]);
const SUPPORTED_ACTIONS = new Set([
  "runtime.status", "skills.list", "plugins.list", "mcp.list", "mcp.tools",
  "mcp.call", "skills.read", "plugins.call", "workspace.list",
  "workspace.read_file", "workspace.create_file", "browser.open_url",
  "terminal.execute"
]);

async function readTaskState(taskId) {
  const stored = await api.storage.local.get([TASK_STATE_KEY, TASKS_KEY, ACTIVE_TASK_KEY]);
  const tasks = stored[TASKS_KEY] || {};
  if (taskId && tasks[taskId]) return tasks[taskId];
  if (!taskId && stored[ACTIVE_TASK_KEY] && tasks[stored[ACTIVE_TASK_KEY]]) return tasks[stored[ACTIVE_TASK_KEY]];
  return stored[TASK_STATE_KEY] || null;
}
function redactActivityText(value) {
  return String(value || "")
    .replace(/(authorization\s*[:=]\s*["']?Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1[REDACTED]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, "$1[REDACTED]")
    .replace(/(api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret)(\s*[:=]\s*["']?)[^\s,"']+/gi, "$1$2[REDACTED]")
    .slice(0, 2500);
}

function activityForState(state, previous) {
  const activity = Array.isArray(state.activity)
    ? state.activity.slice()
    : Array.isArray(previous?.activity) ? previous.activity.slice() : [];
  if (!state.phase || state.phase === previous?.phase) return activity;

  const labels = {
    starting: "Task started",
    submitting_prompt: "Sending prompt to AI website",
    awaiting_model: "Waiting for AI response",
    response_ready: "AI response received",
    awaiting_approval: "Action waiting for approval",
    executing: "Executing action",
    action_completed: "Action finished",
    completed: "Task completed",
    paused: "Task paused",
    interrupted: "Task interrupted",
    error: "Task failed",
    step_limit: "Step limit reached",
    cancelled: "Task permanently stopped"
  };
  const entry = {
    id: (state.id || "task") + ":" + Date.now() + ":" + state.phase,
    at: new Date().toISOString(),
    phase: state.phase,
    title: labels[state.phase] || state.phase.replace(/_/g, " ")
  };

  if (state.action && ["awaiting_approval", "executing"].includes(state.phase)) {
    entry.action = state.action.action;
    const args = state.action.arguments || {};
    entry.command = typeof args.command === "string"
      ? redactActivityText(args.command)
      : redactActivityText(JSON.stringify(args));
    entry.cwd = typeof args.cwd === "string" ? redactActivityText(args.cwd) : "";
  }
  if (state.phase === "action_completed" && state.lastResult) {
    const result = state.lastResult.result || {};
    entry.action = state.lastResult.action;
    entry.ok = result.ok === true;
    entry.returncode = result.returncode ?? null;
    entry.timed_out = result.timed_out === true;
    entry.elapsed_ms = result.elapsed_ms ?? null;
    entry.stdout = redactActivityText(result.stdout || "");
    entry.stderr = redactActivityText(result.stderr || "");
    entry.error = redactActivityText(result.error || "");
  }
  if (["paused", "interrupted", "error", "step_limit"].includes(state.phase)) {
    entry.message = redactActivityText(state.error || "");
  }
  if (state.phase === "completed") {
    entry.message = redactActivityText(state.finalResponse || "").slice(0, 1200);
  }
  activity.push(entry);
  return activity.slice(-40);
}

async function writeTaskState(state) {
  const stored = await api.storage.local.get([TASKS_KEY, ACTIVE_TASK_KEY]);
  const tasks = stored[TASKS_KEY] && typeof stored[TASKS_KEY] === "object" ? stored[TASKS_KEY] : {};
  const id = state.id || stored[ACTIVE_TASK_KEY] || ("task-" + Date.now());
  const previous = tasks[id] || null;
  const next = {
    ...state,
    id,
    activity: activityForState(state, previous),
    updatedAt: new Date().toISOString()
  };
  tasks[id] = next;
  await api.storage.local.set({ [TASK_STATE_KEY]: next, [TASKS_KEY]: tasks, [ACTIVE_TASK_KEY]: id });
  try { await api.runtime.sendMessage({ type: "AGENTOS_TASK_STATE_UPDATED", taskId: id, state: next }); } catch (_) {}
  return next;
}
async function setActiveTask(taskId) {
  const stored = await api.storage.local.get(TASKS_KEY);
  const state = stored[TASKS_KEY]?.[taskId];
  if (state) await api.storage.local.set({ [TASK_STATE_KEY]: state, [ACTIVE_TASK_KEY]: taskId });
}
async function taskStateForActiveTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  try {
    const info = await tabRequest(tab.id, "AGENTOS_PROVIDER_INSPECT");
    if (!info?.ok) return null;
    const stored = await api.storage.local.get(TASKS_KEY);
    const tasks = Object.values(stored[TASKS_KEY] || {});
    const matches = tasks
      .filter(state => state.provider === info.provider && sameConversation(state, info.provider, info.url, info.conversationId))
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    if (matches.length) {
      await setActiveTask(matches[0].id);
      return matches[0];
    }

    // ChatGPT can move a just-continued conversation to a local-chatgpt URL.
    // Adopt that URL only for the same tab/provider while awaiting the model.
    const active = await readTaskState();
    if (active && active.tabId === tab.id && active.provider === info.provider &&
        isVerifiedChatGPTContinuation(active, info.url, info.conversationId, info.continuationMarker === true)) {
      const migrated = await writeTaskState({
        ...active,
        providerUrl: info.url,
        conversationTransfer: {
          ...(active.conversationTransfer || {}),
          observedUrl: info.url,
          observedAt: new Date().toISOString(),
          verifiedBy: info.continuationMarker === true
            ? "chatgpt-continued-from-marker"
            : active.conversationTransfer?.toConversationId
              ? "chatgpt-handoff-conversation-id"
              : "chatgpt-handoff-target-url"
        }
      });
      return migrated;
    }
    return null;
  } catch (_) {
    return null;
  }
}
async function isStopped() {
  const stored = await api.storage.local.get(STOP_KEY);
  return Boolean(stored[STOP_KEY]);
}
async function setStopped(value) {
  await api.storage.local.set({ [STOP_KEY]: Boolean(value) });
  return Boolean(value);
}
async function nativeRequest(payload) {
  const safeControlRequest = ["runtime.status", "workspace.get", "workspace.select_directory"].includes(payload?.type);
  if (payload?.type === "workspace.select_directory") {
    const currentTask = await readTaskState();
    if (currentTask && !["completed", "cancelled", "error", "interrupted", "step_limit"].includes(currentTask.phase)) {
      return { ok: false, error: "Finish or safely stop the current task before changing the workspace folder. This prevents a running task from switching directories mid-execution." };
    }
  }
  if (await isStopped() && !safeControlRequest) {
    return { ok: false, error: "AgentOS is stopped. Resume it before running actions." };
  }
  return new Promise((resolve) => {
    let port;
    let done = false;
    let timer;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { port?.disconnect(); } catch (_) {}
      resolve(value);
    };
    try {
      port = api.runtime.connectNative("com.agentos.host");
    } catch (error) {
      finish({ ok: false, error: String(error) });
      return;
    }
    const isTerminalAction = payload?.type === "action.execute" && payload.action === "terminal.execute";
    const requestedTerminalTimeout = Number.isInteger(payload?.arguments?.timeout_seconds)
      ? payload.arguments.timeout_seconds
      : 120;
    const timeoutMs = payload?.type === "workspace.select_directory"
      ? 180000
      : isTerminalAction
        ? (Math.min(Math.max(requestedTerminalTimeout, 1), 600) + 15000) * 1000
        : 15000;
    const terminalId = isTerminalAction
      ? (payload?.task_id || "task") + ":terminal:" + Date.now() + ":" + (++terminalInvocationSequence)
      : null;
    timer = setTimeout(() => finish({ ok: false, error: "Native host timeout" }), timeoutMs);
    port.onMessage.addListener((message) => {
      if (message?.agentos_event === true) {
        try {
          Promise.resolve(api.runtime.sendMessage({
            type: "AGENTOS_TERMINAL_EVENT",
            taskId: payload?.task_id || null,
            event: terminalId ? { ...message, terminalId } : message
          })).catch(() => {});
        } catch (_) {}
        return;
      }
      finish(message);
    });
    port.onDisconnect.addListener(() => finish({
      ok: false, error: api.runtime.lastError?.message || "Native host disconnected"
    }));
    port.postMessage({ protocol: "agentos.v1", ...payload });
  });
}
async function tabRequest(tabId, type, extra = {}) {
  if (!Number.isInteger(tabId)) throw new Error("The AI website tab is no longer available.");
  const timeoutMs = type === "AGENTOS_PROVIDER_HANDOFF" ? 35000
    : type === "AGENTOS_PROVIDER_SUBMIT" ? 30000
    : type === "AGENTOS_PROVIDER_READ" ? 12000
    : 10000;

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("Timed out waiting for the AI website (" + type + "). The prompt was not automatically resent."));
    }, timeoutMs);

    let request;
    try {
      request = api.tabs.sendMessage(tabId, { type, ...extra });
    } catch (error) {
      clearTimeout(timer);
      reject(error);
      return;
    }
    Promise.resolve(request).then(value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }, error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}
async function readProviderMessages(tabId) {
  const result = await tabRequest(tabId, "AGENTOS_PROVIDER_READ");
  if (!result?.ok) throw new Error(result?.error || "Could not read the AI website response.");
  const messages = (result.messages || []).filter(x => typeof x === "string" && x.trim());
  const messageIds = Array.isArray(result.messageIds) && result.messageIds.length === messages.length
    ? result.messageIds.map(id => typeof id === "string" ? id : "")
    : [];
  return {
    messages,
    messageIds,
    url: result.url || null,
    strategy: result.strategy || null,
    continuationMarker: result.continuationMarker === true,
    conversationId: result.conversationId || null
  };
}
function responseDeltaDetails(messages, baseline, messageIds = [], baselineMessageIds = []) {
  if (!Array.isArray(messages) || !Array.isArray(baseline)) return { response: "", messageIds: [] };
  const identitiesAreAligned =
    Array.isArray(messageIds) &&
    Array.isArray(baselineMessageIds) &&
    messageIds.length === messages.length &&
    baselineMessageIds.length === baseline.length &&
    messageIds.every(id => typeof id === "string" && id.trim()) &&
    baselineMessageIds.every(id => typeof id === "string" && id.trim());
  if (identitiesAreAligned) {
    const previousIds = new Set(baselineMessageIds);
    const newIndexes = messageIds
      .map((id, index) => previousIds.has(id) ? -1 : index)
      .filter(index => index >= 0);
    if (newIndexes.length) {
      return {
        response: newIndexes.map(index => String(messages[index] || "").trim())
          .filter(Boolean).join("\n\n").trim(),
        messageIds: newIndexes.map(index => messageIds[index])
      };
    }
  }
  if (messages.length > baseline.length) {
    return { response: messages.slice(baseline.length).join("\n\n").trim(), messageIds: [] };
  }
  if (messages.length && messages[messages.length - 1] !== baseline[baseline.length - 1]) {
    return { response: String(messages[messages.length - 1]).trim(), messageIds: [] };
  }
  return { response: "", messageIds: [] };
}

function responseDelta(messages, baseline, messageIds = [], baselineMessageIds = []) {
  return responseDeltaDetails(messages, baseline, messageIds, baselineMessageIds).response;
}
async function sendPrompt(state, prompt) {
  if (await isStopped()) return;

  let submitting = null;
  let stage = "checking the conversation";
  try {
    // ChatGPT can block further messages when its context window is full.
    // A handoff starts a new conversation, so discard the old DOM identity.
    if (state.provider === "chatgpt") {
      stage = "checking ChatGPT context window";
      const handoff = await tabRequest(state.tabId, "AGENTOS_PROVIDER_HANDOFF");
      if (handoff?.ok === true && handoff?.handedOff === true && handoff.url) {
        state = await writeTaskState(
          applyChatGPTHandoff(state, handoff)
        );
        // Rebuild only after the provider confirms the context-window handoff,
        // so the newly persisted event and stable task ID travel into the new chat.
        prompt = buildContinuationPrompt(state, state.lastResult || null);
      } else if (handoff?.ok === false) {
        throw new Error(handoff.error || "ChatGPT conversation handoff failed.");
      }
    }

    stage = "reading the active conversation";
    const snapshot = await readProviderMessages(state.tabId);
    const expectedConversationId = state.provider === "chatgpt"
      ? state.providerConversationId
      : null;
    if (expectedConversationId && snapshot.conversationId &&
        expectedConversationId !== snapshot.conversationId) {
      throw new Error(
        "The active ChatGPT conversation identity changed after handoff. " +
        "The prompt was not sent."
      );
    }
    const submittingState = await writeTaskState({
      ...state,
      phase: "submitting_prompt",
      prompt,
      baseline: snapshot.messages,
      baselineMessageIds: snapshot.messageIds || [],
      providerUrl: snapshot.url || state.providerUrl,
      // A verified handoff ID is retained when the DOM temporarily omits it.
      providerConversationId: snapshot.conversationId || state.providerConversationId || null,
      response: null,
      action: null,
      error: null,
      promptSubmissionStage: "ready"
    });
    submitting = submittingState;

    stage = "filling the prompt";
    const fill = await tabRequest(submitting.tabId, "AGENTOS_PROVIDER_FILL", { prompt });
    if (!fill?.ok || fill.filled !== true) {
      throw new Error(fill?.error || "The AI website did not confirm that the prompt was filled.");
    }

    stage = "submitting the prompt";
    const submitted = await tabRequest(submitting.tabId, "AGENTOS_PROVIDER_SUBMIT");
    if (!submitted?.ok || submitted.submitted !== true) {
      throw new Error(submitted?.error || "The AI website did not confirm prompt submission.");
    }

    // Submission is confirmed. Inspection is best-effort because some providers
    // update their SPA URL/DOM identity a moment after accepting the prompt.
    let providerUrl = submitting.providerUrl;
    let providerConversationId = submitting.providerConversationId;
    let conversationIdentityConflict = false;
    try {
      stage = "verifying the conversation";
      const info = await tabRequest(submitting.tabId, "AGENTOS_PROVIDER_INSPECT");
      if (info?.ok && info.provider === submitting.provider) {
        conversationIdentityConflict = submitting.provider === "chatgpt" &&
          Boolean(submitting.providerConversationId && info.conversationId) &&
          submitting.providerConversationId !== info.conversationId;
        if (!conversationIdentityConflict) {
          providerUrl = info.url || providerUrl;
          providerConversationId = info.conversationId || providerConversationId;
        }
      }
    } catch (_) {}
    if (conversationIdentityConflict) {
      throw new Error(
        "ChatGPT reported a different conversation identity after submission. " +
        "The prompt may already have been sent; inspect that conversation before resuming."
      );
    }

    if (await isStopped()) {
      await writeTaskState({
        ...submitting,
        phase: "cancelled",
        action: null,
        error: "Task permanently stopped by the user."
      });
      return;
    }

    const next = await writeTaskState({
      ...submitting,
      phase: "awaiting_model",
      providerUrl,
      providerConversationId,
      promptSubmissionStage: "submitted"
    });
    try {
      await api.alarms.clear("agentos-response-timeout");
      await api.alarms.create("agentos-response-timeout", { delayInMinutes: RESPONSE_TIMEOUT_MINUTES });
      // The provider observer delivers a stable assistant snapshot after generation.
    } catch (_) {}
  } catch (error) {
    const latest = await readTaskState();
    if (latest?.id !== state.id || latest?.phase === "cancelled") return;
    if (await isStopped()) {
      await writeTaskState({
        ...(submitting || latest || state),
        phase: "cancelled",
        action: null,
        error: "Task permanently stopped while submitting the prompt."
      });
      return;
    }
    const base = submitting || latest || state;
    const mayHaveSubmitted = stage === "submitting the prompt" || stage === "verifying the conversation";
    await writeTaskState({
      ...base,
      phase: "error",
      action: null,
      response: null,
      error: "Prompt handoff failed while " + stage + ": " +
        String(error?.message || error) +
        ". AgentOS did not automatically resend the prompt." +
        (mayHaveSubmitted ? " The prompt may already be present in the AI conversation; inspect that conversation before resuming." : ""),
      promptSubmissionStage: stage
    });
  }
}
function validateAction(command) {
  if (!command || command.protocol !== "agentos.v1" || command.type !== "action") return "Invalid AgentOS action envelope.";
  if (!SUPPORTED_ACTIONS.has(command.action)) return "This action is not supported.";
  const args = command.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) return "Action arguments must be an object.";
  const text = (key, optional = false, max = 1024) =>
    (optional && args[key] === undefined) ||
    (typeof args[key] === "string" && args[key].trim().length > 0 && args[key].length <= max);
  switch (command.action) {
    case "mcp.tools":
      if (!text("server", false, 128)) return "mcp.tools requires a server name.";
      break;
    case "mcp.call":
      if (!text("server", false, 128) || !text("tool", false, 128) ||
          (args.arguments !== undefined && (!args.arguments || typeof args.arguments !== "object" || Array.isArray(args.arguments)))) return "mcp.call requires server, tool, and an arguments object.";
      break;
    case "skills.read":
      if (!text("name", false, 64)) return "skills.read requires a skill name.";
      break;
    case "plugins.call":
      if (!text("plugin", false, 128) || !text("tool", false, 128) ||
          (args.arguments !== undefined && (!args.arguments || typeof args.arguments !== "object" || Array.isArray(args.arguments)))) return "plugins.call requires plugin, tool, and an arguments object.";
      break;
    case "workspace.list":
      if (!text("path", true, 1024) && args.path !== "") return "workspace.list path must be text.";
      break;
    case "workspace.read_file":
      if (!text("path", false, 1024)) return "workspace.read_file requires a path.";
      break;
    case "workspace.create_file":
      if (!text("path", false, 1024) || typeof args.content !== "string" || args.content.length > 200000) return "workspace.create_file requires a path and content under 200 KB.";
      break;
    case "browser.open_url":
      if (!text("url", false, 4096)) return "browser.open_url requires a URL.";
      try {
        const url = new URL(args.url);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "Only credential-free HTTP/HTTPS URLs can be opened.";
      } catch (_) { return "The URL is invalid."; }
      break;
    case "terminal.execute":
      if (!text("command", false, 100000)) return "terminal.execute requires a command under 100 KB.";
      if (args.cwd !== undefined && !text("cwd", false, 1024)) return "terminal.execute cwd must be a directory path under 1024 characters.";
      if (args.timeout_seconds !== undefined &&
          (!Number.isInteger(args.timeout_seconds) || args.timeout_seconds < 1 || args.timeout_seconds > 600)) {
        return "terminal.execute timeout_seconds must be an integer from 1 to 600.";
      }
      break;
  }
  return null;
}
function continuePrompt(state, result) {
  return buildContinuationPrompt(state, result);
}
async function executeAction(command, taskId = null) {
  if (await isStopped()) return { ok: false, error: "AgentOS is stopped." };
  if (command.action === "browser.open_url") {
    const url = new URL(command.arguments.url);
    const tab = await api.tabs.create({ url: url.href, active: true });
    return { ok: true, tabId: tab.id, url: url.href };
  }
  return nativeRequest({ type: "action.execute", action: command.action, arguments: command.arguments, task_id: taskId });
}
async function processAction(state, approved) {
  // Hard execution boundary: supervised actions require a persisted user approval.
  // This guard protects against accidental direct calls and response-processing races.
  if (approved && state.autonomy !== "autonomous" && state.approvalGranted !== true) {
    return { ok: false, error: "Supervised action blocked: explicit user approval is required." };
  }
  if (!approved) {
    const rejected = {
      action: state.action.action,
      arguments: state.action.arguments,
      result: { ok: false, rejected: true, reason: "User rejected this action." }
    };
    const actionHistory = [
      ...(Array.isArray(state.actionHistory) ? state.actionHistory : []),
      rejected
    ].slice(-MAX_STEPS);
    const rejectedState = {
      ...state,
      actionHistory,
      lastResult: rejected,
      phase: "action_completed",
      action: null
    };
    const prompt = continuePrompt(rejectedState, rejected);
    await writeTaskState({ ...rejectedState, prompt });
    return sendPrompt({ ...rejectedState, prompt }, prompt);
  }
  if (await isStopped()) return;
  const stageLedgerAtStart = beginStageAttempt(state, state.action);
  const executingState = await writeTaskState({
    ...state, phase: "executing",
    ...(state.action?.action === "terminal.execute" ? { stageLedger: stageLedgerAtStart } : {})
  });
  let result;
  try { result = await executeAction(state.action, state.id); }
  catch (error) { result = { ok: false, error: String(error.message || error) }; }
  const steps = Number(state.steps || 0) + 1;
  const lastResult = { action: state.action.action, arguments: state.action.arguments, result };
  const actionHistory = [
    ...(Array.isArray(state.actionHistory) ? state.actionHistory : []),
    lastResult
  ].slice(-MAX_STEPS);
  // Reset the bounded recovery budget after each valid action.
  const stageLedger = recordStageResult(executingState, lastResult);
  const continuedState = {
    ...state, steps, lastResult, actionHistory, nonActionRetries: 0,
    duplicateStageRetries: 0, protocolRecovery: null,
    ...(state.action?.action === "terminal.execute" ? { stageLedger } : {})
  };
  const prompt = continuePrompt(continuedState, lastResult);
  const completed = await writeTaskState({
    ...continuedState, phase: "action_completed",
    prompt, action: null, response: null, approvalGranted: false
  });
  if (await isStopped()) {
    await writeTaskState({ ...completed, phase: "cancelled", action: null, error: "Task permanently stopped by the user." });
    return;
  }
  if (steps >= MAX_STEPS) {
    await writeTaskState({ ...completed, phase: "step_limit" });
    return;
  }
  if (!(await isStopped())) await sendPrompt(completed, prompt);
}
async function processModelResponse(state, response, responseContext = {}) {
  const ready = await writeTaskState({ ...state, phase: "response_ready", response });
  const action = globalThis.AgentOSActionParser?.extractAction(response) || null;
  if (!action) {
    // Never mark an unfinished numbered task complete because the model
    // returned prose between actions. Recover from the persisted action ledger.
    const stagedWorkRemains = requiresUnfinishedStagedTask(ready);
    const needsAction = requiresAgentAction(ready) &&
      (Number(ready.steps || 0) === 0 || stagedWorkRemains);
    if (needsAction) {
      const retryCount = nextNonActionRetryCount(ready);
      if (retryCount !== null) {
        const retryPrompt = buildNonActionRetryPrompt(ready, response);
        const retryState = await writeTaskState({
          ...ready, phase: "action_completed", response: null,
          finalResponse: null, action: null, error: null,
          nonActionRetries: retryCount, prompt: retryPrompt
        });
        await sendPrompt(retryState, retryPrompt);
        return;
      }
      await writeTaskState({
        ...ready, phase: "error", finalResponse: null,
        protocolRecovery: {
          kind: "non-action-response",
          response,
          messageIds: Array.isArray(responseContext.messageIds) ? responseContext.messageIds : [],
          conversationId: responseContext.conversationId || ready.providerConversationId || null,
          recordedAt: new Date().toISOString()
        },
        error: stagedWorkRemains
          ? "The AI website returned ordinary text instead of the next required AgentOS action. The staged task is still incomplete; no completion was recorded. Resume after inspecting the conversation."
          : "The AI website returned ordinary text instead of a valid AgentOS action after the bounded protocol-recovery attempts. No action was executed. Inspect the AI response before retrying."
      });
      return;
    }
    await writeTaskState({ ...ready, phase: "completed", finalResponse: response, response });
    return;
  }
  const issue = validateAction(action);
  if (issue) {
    const oversizedTerminal = action?.action === "terminal.execute" &&
      typeof action.arguments?.command === "string" &&
      action.arguments.command.length > 12000;
    if (oversizedTerminal) {
      const retries = Number(ready.oversizedTerminalRetries || 0) + 1;
      if (retries <= 2) {
        const retryPrompt = [
          "AgentOS rejected the proposed terminal action BEFORE executing it.",
          "Do not repeat that terminal command and do not put file contents inside a shell command.",
          "For this coding task, create each project file with one workspace.create_file action using a workspace-relative path and its content. Use terminal.execute only for short commands (under 12 KB), such as running tests or listing files.",
          "Continue the original task from the current workspace. No part of the rejected command was executed.",
          "Original task:", ready.task,
          "Validation error:", issue,
          "Rejected command length:", String(action.arguments.command.length), "characters"
        ].join("\n\n");
        const retryState = await writeTaskState({
          ...ready, phase: "action_completed", action: null,
          error: null, oversizedTerminalRetries: retries, prompt: retryPrompt
        });
        await sendPrompt(retryState, retryPrompt);
        return;
      }
    }
    await writeTaskState({ ...ready, phase: "error", error: "Invalid model action: " + issue });
    return;
  }
  const approvalNeeded = ready.autonomy !== "autonomous" || !AUTONOMOUS_ACTIONS.has(action.action);
  if (isStageAlreadyPassed(ready, action)) {
    const retryCount = nextDuplicateStageRetryCount(ready);
    if (retryCount === null) {
      await writeTaskState({
        ...ready, phase: "error", action: null,
        error: "The model repeatedly proposed a terminal command for a stage already recorded as passed. The duplicate command was not executed."
      });
      return;
    }
    const retryPrompt = buildDuplicateStageRetryPrompt(ready, action);
    const retryState = await writeTaskState({
      ...ready, phase: "action_completed", action: null, response: null,
      finalResponse: null, duplicateStageRetries: retryCount,
      prompt: retryPrompt, error: null
    });
    await sendPrompt(retryState, retryPrompt);
    return;
  }
  const awaiting = await writeTaskState({
    ...ready,
    phase: approvalNeeded ? "awaiting_approval" : "executing",
    action,
    approvalGranted: false
  });
  if (approvalNeeded) return;
  await processAction(awaiting, true);
}
let responseProcessingTaskId = null;
async function handleAssistantSnapshot(tabId, messages, rawUrl, strategy, continuationMarker = false, messageIds = [], conversationId = null) {
  let state = await readTaskState();
  // A timed-out task may still have a valid assistant response in the continued
  // ChatGPT conversation. Re-arm only this exact no-action/no-response timeout
  // state when the continuation marker verifies the pending handoff.
  if (state?.tabId === tabId &&
      state.phase === "error" &&
      state.error === "Timed out waiting for a completed response from the AI website. The prompt was not sent again." &&
      state.provider === "chatgpt" &&
      continuationMarker === true &&
      state.conversationTransfer?.to === state.providerUrl &&
      !state.action && !state.response) {
    state = await writeTaskState({ ...state, phase: "awaiting_model", error: null });
  }

  // A send click can be accepted by ChatGPT even when its DOM confirmation
  // arrives late. If a genuinely new assistant message is observed against
  // the saved pre-submit baseline, safely re-arm this task and process it.
  const ambiguousSubmitResult = state?.phase === "error" &&
    state.promptSubmissionStage === "submitting the prompt" &&
    /could not verify that ChatGPT accepted the prompt|did not confirm submission/i.test(state.error || "") &&
    !state.action && !state.response &&
    Array.isArray(state.baseline);
  if (state?.tabId === tabId && ambiguousSubmitResult) {
    const possibleResponse = responseDelta(
      messages,
      state.baseline || [],
      messageIds,
      state.baselineMessageIds || []
    );
    if (possibleResponse) {
      state = await writeTaskState({
        ...state,
        phase: "awaiting_model",
        error: null,
        promptSubmissionStage: "submitted-unconfirmed"
      });
    }
  }
  if (!state || state.tabId !== tabId) {
    return { ok: true, accepted: true, reason: "no-task-for-tab" };
  }
  if (state.phase === "cancelled") {
    return { ok: true, accepted: true, reason: "task-permanently-stopped" };
  }
  const verifiedChatGPTIdentity = chatGPTConversationIdentityMatches(state, conversationId);
  if (rawUrl && verifiedChatGPTIdentity && state.providerUrl !== rawUrl) {
    state = await writeTaskState({ ...state, providerUrl: rawUrl, conversationTransfer: { ...(state.conversationTransfer || {}), from: state.providerUrl, to: rawUrl, observedUrl: rawUrl, verifiedBy: "chatgpt-dom-conversation-id", verifiedAt: new Date().toISOString() } });
  }
  if (rawUrl && !sameConversation(state, state.provider, rawUrl, conversationId)) {
    const verifiedChatGPTContinuation = isVerifiedChatGPTContinuation(
      state, rawUrl, conversationId, continuationMarker === true
    );
    if (verifiedChatGPTContinuation) {
      state = await writeTaskState({
        ...state,
        providerUrl: rawUrl,
        conversationTransfer: {
          ...(state.conversationTransfer || {}),
          observedUrl: rawUrl,
          observedAt: new Date().toISOString(),
          verifiedBy: continuationMarker === true
            ? "chatgpt-continued-from-marker"
            : state.conversationTransfer?.toConversationId
              ? "chatgpt-handoff-conversation-id"
              : "chatgpt-handoff-target-url"
        }
      });
    } else {
      return { ok: true, accepted: true, reason: "different-conversation" };
    }
  }
  if (["starting", "submitting_prompt"].includes(state.phase)) {
    return { ok: true, accepted: false, reason: "task-transitioning" };
  }
  const recoverableProtocolError = isRecoverableNonActionProtocolError(state);
  if ((state.phase !== "awaiting_model" && !recoverableProtocolError) || await isStopped()) {
    return { ok: true, accepted: true, reason: "task-not-awaiting-model" };
  }
  // ChatGPT's root fallback can include the entire page (including the
  // injected task prompt and sidebar text), not an assistant-authored turn.
  // Never let that page-wide text falsely complete or advance an AgentOS task.
  if (state.provider === "chatgpt" && strategy !== "semantic selectors") {
    return { ok: true, accepted: true, reason: "unsafe-chatgpt-snapshot-strategy" };
  }
  const delta = responseDeltaDetails(
    messages, state.baseline || [], messageIds, state.baselineMessageIds || []
  );
  if (!delta.response) {
    return { ok: true, accepted: true, reason: "no-new-response" };
  }
  if (recoverableProtocolError) {
    const recovered = recoverNonActionProtocolState(state, delta.response, delta.messageIds);
    if (!recovered) {
      return { ok: true, accepted: true, reason: "protocol-error-response-already-seen" };
    }
    // Persist only this safe transition. Keep the task identity, completed
    // action history, stage/handoff ledgers, and retry budget unchanged.
    state = await writeTaskState(recovered);
  }
  if (responseProcessingTaskId === state.id) {
    return { ok: true, accepted: true, reason: "response-already-processing" };
  }
  responseProcessingTaskId = state.id;
  try {
    await api.alarms.clear("agentos-response-timeout");
    await processModelResponse(state, delta.response, {
      messageIds: delta.messageIds,
      conversationId,
      url: rawUrl
    });
    return { ok: true, accepted: true, reason: "response-processed" };
  } finally {
    if (responseProcessingTaskId === state.id) responseProcessingTaskId = null;
  }
}
let responseReconcileInFlight = false;
async function checkAwaitingModelResponse() {
  if (responseReconcileInFlight) return { ok: true, checked: false, reason: "response-check-already-running" };
  responseReconcileInFlight = true;
  try {
    let state = await readTaskState();
    const ambiguousSubmitResult = state?.phase === "error" &&
      state.promptSubmissionStage === "submitting the prompt" &&
      /could not verify that ChatGPT accepted the prompt|did not confirm submission/i.test(state.error || "") &&
      !state.action && !state.response &&
      Array.isArray(state.baseline);

    // Manual recovery path for an ambiguous Send confirmation. Inspect the
    // same conversation and saved pre-submit baseline; never click Send again.
    if (ambiguousSubmitResult) {
      const info = await tabRequest(state.tabId, "AGENTOS_PROVIDER_INSPECT");
      if (!info?.ok || info.provider !== state.provider ||
          !sameConversation(state, info.provider, info.url, info.conversationId)) {
        return {
          ok: true, checked: true, reason: "original-conversation-not-confirmed",
          state
        };
      }
      const snapshot = await readProviderMessages(state.tabId);
      const response = responseDelta(
        snapshot.messages,
        state.baseline || [],
        snapshot.messageIds || [],
        state.baselineMessageIds || []
      );
      if (!response) {
        return {
          ok: true, checked: true, reason: "ambiguous-submit-no-new-response",
          state
        };
      }
      state = await writeTaskState({
        ...state,
        phase: "awaiting_model",
        error: null,
        promptSubmissionStage: "submitted-unconfirmed"
      });
      const recovered = await handleAssistantSnapshot(
        state.tabId, snapshot.messages, snapshot.url, snapshot.strategy,
        snapshot.continuationMarker, snapshot.messageIds, snapshot.conversationId
      );
      return {
        ...recovered,
        checked: true,
        reason: recovered.reason || "late-response-recovered",
        state: await readTaskState()
      };
    }

    if (!state || (state.phase !== "awaiting_model" && !isRecoverableNonActionProtocolError(state))) {
      return { ok: true, checked: false, reason: "task-not-awaiting-model", state: state || null };
    }
    if (await isStopped()) {
      return { ok: true, checked: false, reason: "agent-stopped", state };
    }
    if (responseProcessingTaskId === state.id) {
      return { ok: true, checked: false, reason: "response-already-processing", state };
    }

    // Poll the provider directly as a fallback to the page MutationObserver.
    // This also gives the user a manual "check now" recovery path.
    const info = await tabRequest(state.tabId, "AGENTOS_PROVIDER_INSPECT");
    if (!info?.ok) {
      return { ok: false, checked: true, error: info?.error || "Could not inspect the original AI tab.", state };
    }
    if (info.provider !== state.provider) {
      return { ok: true, checked: true, reason: "provider-mismatch", state };
    }

    if (info.generationInProgress === true) {
      return { ok: true, checked: true, reason: "generation-in-progress", state };
    }
    const snapshot = await readProviderMessages(state.tabId);
    const result = await handleAssistantSnapshot(
      state.tabId, snapshot.messages, snapshot.url, snapshot.strategy,
      snapshot.continuationMarker, snapshot.messageIds, snapshot.conversationId
    );
    return { ...result, checked: true, state: await readTaskState() };
  } catch (error) {
    return { ok: false, checked: true, error: String(error.message || error) };
  } finally {
    responseReconcileInFlight = false;
  }
}

// Poll while a task waits for the model. The content-script observer remains the
// fast path; this catches missed DOM notifications and late content-script delivery.
setInterval(() => {
  checkAwaitingModelResponse().catch(error => {
    console.warn("[AgentOS] Background response reconciliation failed.", error);
  });
}, 2500);

async function startTask(message) {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("Open a supported AI website tab first.");
  const info = await tabRequest(tab.id, "AGENTOS_PROVIDER_INSPECT");
  if (!info?.ok || !info.composerAvailable) throw new Error(info?.error || "The active tab does not have a supported AI message box.");
  const existing = await readTaskState();
  if (existing && !["completed", "cancelled", "error", "interrupted", "step_limit"].includes(existing.phase)) {
    if (sameConversation(existing, info.provider, info.url, info.conversationId)) {
      throw new Error("A task is already active or paused in this conversation. Resume or review it before starting another task here.");
    }
    if (["executing", "submitting_prompt"].includes(existing.phase)) {
      throw new Error("The previous task is in a critical execution step. Wait for it to finish before switching to another task.");
    }
    if (["awaiting_model", "awaiting_approval", "action_completed"].includes(existing.phase)) {
      await writeTaskState({ ...existing, phase: "paused", resumePhase: existing.phase, error: "Paused automatically because you switched to another AI conversation. Return to the original conversation and resume this task." });
    }
  }
  const initialPrompt = message.prompt;
  if (typeof initialPrompt !== "string" || !initialPrompt.trim()) {
    throw new Error("The initial AgentOS prompt is missing or empty.");
  }
  await setStopped(false);
  const id = "task-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const runContext = buildTaskRunContext(initialPrompt, id);
  const state = {
    id, task: message.task, initialPrompt, actionHistory: [],
    ...(runContext || {}),
    autonomy: message.autonomy === "autonomous" ? "autonomous" : "supervised",
    tabId: tab.id, provider: info.provider, providerUrl: info.url,
    providerConversationId: info.conversationId || null,
    steps: 0, phase: "starting", startedAt: new Date().toISOString()
  };
  const prompt = buildInitialTaskPrompt(state, initialPrompt);
  await setActiveTask(id);
  await writeTaskState(state);
  await sendPrompt(state, prompt);
  return { ok: true, state: await readTaskState(id) };
}
async function reattachTaskTab(state) {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("Reopen the original AI conversation in a tab, then resume the task.");
  const info = await tabRequest(tab.id, "AGENTOS_PROVIDER_INSPECT");
  if (!info?.ok || !info.composerAvailable) throw new Error("The active tab is not a supported AI conversation. Reopen the task's AI website first.");
  if (state.provider && info.provider !== state.provider) throw new Error("Open the same AI provider used by this task before resuming.");
  if (!sameConversation(state, info.provider, info.url, info.conversationId)) {
    throw new Error("Open the original AI conversation before resuming this task. AgentOS could not verify its conversation identity.");
  }
  return { ...state, tabId: tab.id };
}
async function resumeTask(taskId) {
  const state = await readTaskState(taskId);
  if (state?.id) await setActiveTask(state.id);
  if (!state) throw new Error("There is no saved task.");
  const wasStopped = await isStopped();
  await setStopped(false);
  if (state.phase === "response_ready" && state.response) {
    await processModelResponse(state, state.response);
  } else if (state.phase === "paused" && state.resumePhase === "awaiting_model") {
    const attached = await reattachTaskTab(state);
    const resumed = await writeTaskState({ ...attached, phase: "awaiting_model", resumePhase: null });
    try {
      await api.alarms.create("agentos-response-timeout", { delayInMinutes: RESPONSE_TIMEOUT_MINUTES });
      const snapshot = await readProviderMessages(resumed.tabId);
      await handleAssistantSnapshot(resumed.tabId, snapshot.messages, snapshot.url, snapshot.strategy, snapshot.continuationMarker, snapshot.messageIds, snapshot.conversationId);
    } catch (_) {}
  } else if (state.phase === "paused" && state.resumePhase === "awaiting_approval") {
    const attached = await reattachTaskTab(state);
    await writeTaskState({ ...attached, phase: "awaiting_approval", resumePhase: null });
  } else if (state.phase === "paused" && state.resumePhase === "action_completed" && state.prompt) {
    const attached = await reattachTaskTab(state);
    await sendPrompt(attached, state.prompt);
  } else if (state.phase === "submitting_prompt" || (state.phase === "paused" && state.resumePhase === "submitting_prompt")) {
    await writeTaskState({ ...state, phase: "interrupted", error: "The browser stopped while sending a prompt. Whether it reached the model is unknown; it was not sent again." });
  } else if (state.phase === "paused" && state.resumePhase === "executing") {
    await writeTaskState({ ...state, phase: "interrupted", error: "The tab or extension stopped during an action. Its outcome is unknown; it was not replayed." });
  } else if (state.phase === "action_completed" && state.prompt) {
    await sendPrompt(state, state.prompt);
  } else if (state.phase === "awaiting_approval") {
    try { await api.runtime.sendMessage({ type: "AGENTOS_TASK_STATE_UPDATED", state }); } catch (_) {}
  } else if (state.phase === "awaiting_model") {
    try {
      await api.alarms.create("agentos-response-timeout", { delayInMinutes: RESPONSE_TIMEOUT_MINUTES });
      const snapshot = await readProviderMessages(state.tabId);
      await handleAssistantSnapshot(
        state.tabId, snapshot.messages, snapshot.url, snapshot.strategy,
        snapshot.continuationMarker, snapshot.messageIds, snapshot.conversationId
      );
    } catch (_) {}
  } else if (state.phase === "executing" && wasStopped) {
    // The stop request only blocks the next agent step. Let the in-flight action finish;
    // clearing the global stop flag lets processAction continue without replaying it.
  } else if (state.phase === "executing") {
    await writeTaskState({ ...state, phase: "interrupted", error: "The browser stopped during an action. Its outcome is unknown; it was not replayed." });
  } else if (state.phase === "paused" && !state.resumePhase) {
    // Legacy or incomplete checkpoint: do not replay a prompt or action whose outcome cannot be established.
    await writeTaskState({
      ...state,
      phase: "interrupted",
      error: "This saved task had no recovery checkpoint. AgentOS did not resend the prompt or replay an action. Review the AI conversation and workspace before starting a new task."
    });
  } else {
    throw new Error("This task checkpoint cannot be resumed safely. Start a new task after reviewing it.");
  }
  return { ok: true, state: await readTaskState() };
}
async function permanentlyStopTask() {
  await setStopped(true);
  await api.alarms.clear("agentos-response-timeout");
  const state = await readTaskState();
  if (!state) return { ok: true, stopped: true, pending: false, state: null };
  if (["executing", "submitting_prompt"].includes(state.phase)) {
    return { ok: true, stopped: true, pending: true, state,
      message: "Stop requested. The current action/prompt handoff will finish safely; no next step will start." };
  }
  const cancelled = await writeTaskState({
    ...state, phase: "cancelled", action: null, approvalGranted: false,
    resumePhase: null, error: "Task permanently stopped by the user."
  });
  return { ok: true, stopped: true, pending: false, state: cancelled };
}
async function clearActiveTaskHistory() {
  const stored = await api.storage.local.get([TASK_STATE_KEY, TASKS_KEY, ACTIVE_TASK_KEY]);
  const tasks = stored[TASKS_KEY] && typeof stored[TASKS_KEY] === "object" ? { ...stored[TASKS_KEY] } : {};
  const id = stored[ACTIVE_TASK_KEY] || stored[TASK_STATE_KEY]?.id;
  const state = id ? tasks[id] || stored[TASK_STATE_KEY] : null;
  if (state && ["executing", "submitting_prompt"].includes(state.phase)) {
    return { ok: false, error: "Cannot clear history while an action or prompt handoff is still running. Permanently stop it and wait until it finishes." };
  }
  if (id) delete tasks[id];
  await api.storage.local.set({ [TASKS_KEY]: tasks });
  await api.storage.local.remove([TASK_STATE_KEY, ACTIVE_TASK_KEY]);
  await api.alarms.clear("agentos-response-timeout");
  await setStopped(false);
  try { await api.runtime.sendMessage({ type: "AGENTOS_TASK_STATE_UPDATED", taskId: id || null, state: null }); } catch (_) {}
  return { ok: true, cleared: true, taskId: id || null };
}
async function openSafeUrl(raw) {
  if (await isStopped()) return { ok: false, error: "AgentOS is stopped." };
  try {
    if (typeof raw !== "string" || !raw.trim() || raw.length > 4096) throw new Error("URL must be text under 4096 characters");
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Only credential-free HTTP/HTTPS URLs are allowed");
    const tab = await api.tabs.create({ url: url.href, active: true });
    return { ok: true, tabId: tab.id, url: url.href };
  } catch (error) { return { ok: false, error: String(error.message || error) }; }
}
async function activeTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");
  return tab;
}
async function providerRequest(type, extra = {}) {
  const tab = await activeTab();
  try { return await api.tabs.sendMessage(tab.id, { type, ...extra }); }
  catch (_) { return { ok: false, error: "Open Z.ai, ChatGPT, Claude, or Gemini in the active tab first." }; }
}

api.action.onClicked.addListener(async () => {
  try { await api.sidebarAction.open(); }
  catch (error) { console.error("AgentOS sidebar:", error); }
});
api.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "AGENTOS_NATIVE_REQUEST") return nativeRequest(message.payload);
  if (message?.type === "AGENTOS_TASK_STATE_GET") return taskStateForActiveTab().then(state => ({ ok: true, state }));
  if (message?.type === "AGENTOS_TASK_STATE_SET") return writeTaskState(message.state).then(state => ({ ok: true, state }));
  if (message?.type === "AGENTOS_TASK_CHECK_RESPONSE") return checkAwaitingModelResponse();
  if (message?.type === "AGENTOS_TASK_START") return startTask(message);
  if (message?.type === "AGENTOS_TASK_RESUME") return resumeTask(message.taskId);
  if (message?.type === "AGENTOS_TASK_APPROVAL") return readTaskState().then(async state => {
    if (!state || state.phase !== "awaiting_approval" || !state.action) return { ok: false, error: "No action is waiting for approval." };
    const approved = Boolean(message.approved);
    // Persist the user's explicit decision before entering the execution path.
    const decided = approved
      ? await writeTaskState({ ...state, approvalGranted: true })
      : state;
    await processAction(decided, approved);
    return { ok: true };
  });
  if (message?.type === "AGENTOS_TASK_PERMANENT_STOP") return permanentlyStopTask();
  if (message?.type === "AGENTOS_TASK_HISTORY_CLEAR") return clearActiveTaskHistory();
  if (message?.type === "AGENTOS_TASK_STOP") return setStopped(true).then(async () => {
    const state = await readTaskState();
    if (state && ["awaiting_model", "awaiting_approval", "action_completed"].includes(state.phase)) {
      await writeTaskState({ ...state, phase: "paused", resumePhase: state.phase });
    }
    // While an action is executing, the stop flag prevents the next step.
    // Do not rewrite the executing checkpoint: that action must be allowed to finish.
    return { ok: true, stopped: true };
  });
  if (message?.type === "AGENTOS_SET_STOP") return setStopped(message.value).then(stopped => ({ ok: true, stopped }));
  if (message?.type === "AGENTOS_GET_STOP") return api.storage.local.get(STOP_KEY).then(value => ({ stopped: Boolean(value[STOP_KEY]) }));
  if (message?.type === "AGENTOS_OPEN_URL") return openSafeUrl(message.url);
  if (message?.type === "AGENTOS_PAGE_INFO") return providerRequest("AGENTOS_READ_PAGE");
  if (message?.type === "AGENTOS_PROVIDER_INSPECT") return providerRequest("AGENTOS_PROVIDER_INSPECT");
  if (message?.type === "AGENTOS_PROVIDER_READ") return providerRequest("AGENTOS_PROVIDER_READ");
  if (message?.type === "AGENTOS_PROVIDER_FILL") return providerRequest("AGENTOS_PROVIDER_FILL", { prompt: message.prompt });
  if (message?.type === "AGENTOS_PROVIDER_SUBMIT") return providerRequest("AGENTOS_PROVIDER_SUBMIT");
  if (message?.type === "AGENTOS_PROVIDER_SNAPSHOT" && sender.tab?.id) {
    return handleAssistantSnapshot(sender.tab.id, message.messages, message.url, message.strategy, message.continuationMarker === true, message.messageIds || [], message.conversationId || null).catch(async error => {
      const state = await readTaskState();
      if (state && state.tabId === sender.tab.id && state.phase === "awaiting_model") {
        await writeTaskState({ ...state, phase: "error", error: String(error.message || error) });
      }
      return { ok: false, error: String(error.message || error) };
    });
  }
});

api.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== "agentos-response-timeout") return;
  let state = await readTaskState();
  if (state?.phase !== "awaiting_model") return;
  if (responseProcessingTaskId === state.id) return;

  // Last-chance reconciliation: a provider response can become stable at the
  // same moment the timeout alarm fires (notably during ChatGPT continuation).
  // Re-read twice before failing so a completed semantic assistant turn is not
  // discarded merely because its observer snapshot arrived late.
  try {
    const first = await readProviderMessages(state.tabId);
    if (first.strategy === "semantic selectors" && first.messages.length) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      const second = await readProviderMessages(state.tabId);
      const firstSignature = JSON.stringify({ ids: first.messageIds, messages: first.messages });
      const secondSignature = JSON.stringify({ ids: second.messageIds, messages: second.messages });
      if (second.strategy === "semantic selectors" && firstSignature === secondSignature) {
        await handleAssistantSnapshot(
          state.tabId, second.messages, second.url, second.strategy,
          second.continuationMarker, second.messageIds, second.conversationId
        );
      }
    }
  } catch (_) {}

  state = await readTaskState();
  if (state?.phase === "awaiting_model" && responseProcessingTaskId !== state.id) {
    await writeTaskState({ ...state, phase: "error", error: "Timed out waiting for a completed response from the AI website. The prompt was not sent again." });
  }
});
api.tabs.onRemoved.addListener(async tabId => {
  const state = await readTaskState();
  if (state?.tabId === tabId && !["completed", "cancelled", "error"].includes(state.phase)) {
    await writeTaskState({ ...state, phase: "paused", resumePhase: state.phase, error: "The AI website tab was closed. Reopen the same AI conversation in the active tab, then resume." });
  }
});
async function recoverInterruptedAction() {
  const state = await readTaskState();
  if (state?.phase === "executing") {
    await writeTaskState({ ...state, phase: "interrupted", error: "Firefox restarted during an action. Its outcome is unknown; it was not replayed." });
  } else if (state?.phase === "submitting_prompt") {
    await writeTaskState({ ...state, phase: "interrupted", error: "Firefox restarted while sending a prompt. Whether it reached the model is unknown; it was not sent again." });
  }
}
api.runtime.onStartup.addListener(recoverInterruptedAction);
api.runtime.onInstalled.addListener(recoverInterruptedAction);
