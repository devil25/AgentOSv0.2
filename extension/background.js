const api = globalThis.browser;
const TASK_STATE_KEY = "agentos.taskState";
const TASKS_KEY = "agentos.tasks";
const ACTIVE_TASK_KEY = "agentos.activeTaskId";
const STOP_KEY = "agentos.stopped";
const MAX_STEPS = 40;
const RESPONSE_TIMEOUT_MINUTES = 8;
const AUTONOMOUS_ACTIONS = new Set([
  "runtime.status", "skills.list", "skills.read", "workspace.list",
  "workspace.read_file", "workspace.create_file", "terminal.execute"
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
async function writeTaskState(state) {
  const stored = await api.storage.local.get([TASKS_KEY, ACTIVE_TASK_KEY]);
  const tasks = stored[TASKS_KEY] && typeof stored[TASKS_KEY] === "object" ? stored[TASKS_KEY] : {};
  const id = state.id || stored[ACTIVE_TASK_KEY] || ("task-" + Date.now());
  const next = { ...state, id, updatedAt: new Date().toISOString() };
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
function sameConversation(a, provider, url) {
  try {
    const oldUrl = new URL(a.providerUrl), newUrl = new URL(url);
    return a.provider === provider && oldUrl.origin === newUrl.origin && oldUrl.pathname === newUrl.pathname;
  } catch (_) { return a.provider === provider && a.providerUrl === url; }
}
function isChatGPTContinuationUrl(provider, url) {
  if (provider !== "chatgpt" || !url) return false;
  try {
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname);
    return ["chatgpt.com", "chat.openai.com"].includes(parsed.hostname) &&
      /^\/c\/local-chatgpt:/i.test(path);
  } catch (_) { return false; }
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
      .filter(state => state.provider === info.provider && sameConversation(state, info.provider, info.url))
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    if (matches.length) {
      await setActiveTask(matches[0].id);
      return matches[0];
    }

    // ChatGPT can move a just-continued conversation to a local-chatgpt URL.
    // Adopt that URL only for the same tab/provider while awaiting the model.
    const active = await readTaskState();
    if (active && active.tabId === tab.id && active.provider === info.provider &&
        active.phase === "awaiting_model" &&
        isChatGPTContinuationUrl(info.provider, info.url)) {
      const migrated = await writeTaskState({
        ...active,
        providerUrl: info.url,
        conversationTransfer: {
          from: active.providerUrl,
          to: info.url,
          at: new Date().toISOString()
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
    const timeoutMs = payload?.type === "workspace.select_directory" ? 180000 : 15000;
    timer = setTimeout(() => finish({ ok: false, error: "Native host timeout" }), timeoutMs);
    port.onMessage.addListener(finish);
    port.onDisconnect.addListener(() => finish({
      ok: false, error: api.runtime.lastError?.message || "Native host disconnected"
    }));
    port.postMessage({ protocol: "agentos.v1", ...payload });
  });
}
async function tabRequest(tabId, type, extra = {}) {
  if (!Number.isInteger(tabId)) throw new Error("The AI website tab is no longer available.");
  return api.tabs.sendMessage(tabId, { type, ...extra });
}
async function readProviderMessages(tabId) {
  const result = await tabRequest(tabId, "AGENTOS_PROVIDER_READ");
  if (!result?.ok) throw new Error(result?.error || "Could not read the AI website response.");
  return {
    messages: (result.messages || []).filter(x => typeof x === "string" && x.trim()),
    url: result.url || null
  };
}
function responseDelta(messages, baseline) {
  if (!Array.isArray(messages) || !Array.isArray(baseline)) return "";
  if (messages.length > baseline.length) return messages.slice(baseline.length).join("\n\n").trim();
  if (messages.length && messages[messages.length - 1] !== baseline[baseline.length - 1]) {
    return String(messages[messages.length - 1]).trim();
  }
  return "";
}
async function sendPrompt(state, prompt) {
  if (await isStopped()) return;
  const snapshot = await readProviderMessages(state.tabId);
  const baseline = snapshot.messages;
  const submitting = await writeTaskState({
    ...state, phase: "submitting_prompt", prompt, baseline,
    providerUrl: snapshot.url || state.providerUrl,
    response: null, action: null, error: null
  });
  await tabRequest(submitting.tabId, "AGENTOS_PROVIDER_FILL", { prompt });
  await tabRequest(submitting.tabId, "AGENTOS_PROVIDER_SUBMIT");
  let providerUrl = submitting.providerUrl;
  try {
    const info = await tabRequest(submitting.tabId, "AGENTOS_PROVIDER_INSPECT");
    if (info?.ok && info.url) providerUrl = info.url;
  } catch (_) {}
  const next = await writeTaskState({ ...submitting, phase: "awaiting_model", providerUrl });
  try {
    await api.alarms.clear("agentos-response-timeout");
    await api.alarms.create("agentos-response-timeout", { delayInMinutes: RESPONSE_TIMEOUT_MINUTES });
    const latest = await readProviderMessages(next.tabId);
    if (latest.url) {
      try {
        const before = new URL(next.providerUrl), after = new URL(latest.url);
        if (before.origin === after.origin && (before.pathname === "/" || before.pathname === after.pathname)) {
          next.providerUrl = latest.url;
          await writeTaskState(next);
        }
      } catch (_) {}
    }
    await handleAssistantSnapshot(next.tabId, latest.messages, latest.url);
  } catch (_) {}
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
      if (!text("command", false, 12000)) return "terminal.execute requires a command under 12 KB.";
      break;
  }
  return null;
}
function continuePrompt(state, result) {
  return [
    "Continue the SAME original task. AgentOS executed the previous action and is returning its actual result below.",
    "Use this result as ground truth. Do not repeat a successful action. If more work is needed, emit exactly one next action envelope. If complete, answer normally in prose.",
    "Original task:", state.task,
    "Latest action result:", JSON.stringify(result, null, 2)
  ].join("\n\n");
}
async function executeAction(command) {
  if (await isStopped()) return { ok: false, error: "AgentOS is stopped." };
  if (command.action === "browser.open_url") {
    const url = new URL(command.arguments.url);
    const tab = await api.tabs.create({ url: url.href, active: true });
    return { ok: true, tabId: tab.id, url: url.href };
  }
  return nativeRequest({ type: "action.execute", action: command.action, arguments: command.arguments });
}
async function processAction(state, approved) {
  // Hard execution boundary: supervised actions require a persisted user approval.
  // This guard protects against accidental direct calls and response-processing races.
  if (approved && state.autonomy !== "autonomous" && state.approvalGranted !== true) {
    return { ok: false, error: "Supervised action blocked: explicit user approval is required." };
  }
  if (!approved) {
    const rejected = { ok: false, rejected: true, action: state.action.action, reason: "User rejected this action." };
    const prompt = continuePrompt(state, rejected);
    await writeTaskState({ ...state, phase: "action_completed", prompt, action: null });
    return sendPrompt({ ...state, phase: "action_completed" }, prompt);
  }
  if (await isStopped()) return;
  await writeTaskState({ ...state, phase: "executing" });
  let result;
  try { result = await executeAction(state.action); }
  catch (error) { result = { ok: false, error: String(error.message || error) }; }
  const steps = Number(state.steps || 0) + 1;
  const lastResult = { action: state.action.action, arguments: state.action.arguments, result };
  const prompt = continuePrompt(state, lastResult);
  const completed = await writeTaskState({
    ...state, phase: "action_completed", steps, lastResult,
    prompt, action: null, response: null, approvalGranted: false
  });
  if (steps >= MAX_STEPS) {
    await writeTaskState({ ...completed, phase: "step_limit" });
    return;
  }
  if (!(await isStopped())) await sendPrompt(completed, prompt);
}
async function processModelResponse(state, response) {
  const ready = await writeTaskState({ ...state, phase: "response_ready", response });
  const action = globalThis.AgentOSActionParser?.extractAction(response) || null;
  if (!action) {
    await writeTaskState({ ...ready, phase: "completed", finalResponse: response, response });
    return;
  }
  const issue = validateAction(action);
  if (issue) {
    await writeTaskState({ ...ready, phase: "error", error: "Invalid model action: " + issue });
    return;
  }
  const approvalNeeded = ready.autonomy !== "autonomous" || !AUTONOMOUS_ACTIONS.has(action.action);
  const awaiting = await writeTaskState({
    ...ready,
    phase: approvalNeeded ? "awaiting_approval" : "executing",
    action,
    approvalGranted: false
  });
  if (approvalNeeded) return;
  await processAction(awaiting, true);
}
async function handleAssistantSnapshot(tabId, messages, rawUrl) {
  let state = await readTaskState();
  if (!state || state.tabId !== tabId) {
    return { ok: true, accepted: true, reason: "no-task-for-tab" };
  }
  if (rawUrl && !sameConversation(state, state.provider, rawUrl)) {
    if (state.phase === "awaiting_model" && isChatGPTContinuationUrl(state.provider, rawUrl)) {
      state = await writeTaskState({
        ...state,
        providerUrl: rawUrl,
        conversationTransfer: {
          from: state.providerUrl,
          to: rawUrl,
          at: new Date().toISOString()
        }
      });
    } else {
      return { ok: true, accepted: true, reason: "different-conversation" };
    }
  }
  if (["starting", "submitting_prompt"].includes(state.phase)) {
    return { ok: true, accepted: false, reason: "task-transitioning" };
  }
  if (state.phase !== "awaiting_model" || await isStopped()) {
    return { ok: true, accepted: true, reason: "task-not-awaiting-model" };
  }
  const response = responseDelta(messages, state.baseline || []);
  if (!response) {
    return { ok: true, accepted: true, reason: "no-new-response" };
  }
  await api.alarms.clear("agentos-response-timeout");
  await processModelResponse(state, response);
  return { ok: true, accepted: true, reason: "response-processed" };
}
async function startTask(message) {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("Open a supported AI website tab first.");
  const info = await tabRequest(tab.id, "AGENTOS_PROVIDER_INSPECT");
  if (!info?.ok || !info.composerAvailable) throw new Error(info?.error || "The active tab does not have a supported AI message box.");
  const existing = await readTaskState();
  if (existing && !["completed", "cancelled", "error", "interrupted", "step_limit"].includes(existing.phase)) {
    if (sameConversation(existing, info.provider, info.url)) {
      throw new Error("A task is already active or paused in this conversation. Resume or review it before starting another task here.");
    }
    if (["executing", "submitting_prompt"].includes(existing.phase)) {
      throw new Error("The previous task is in a critical execution step. Wait for it to finish before switching to another task.");
    }
    if (["awaiting_model", "awaiting_approval", "action_completed"].includes(existing.phase)) {
      await writeTaskState({ ...existing, phase: "paused", resumePhase: existing.phase, error: "Paused automatically because you switched to another AI conversation. Return to the original conversation and resume this task." });
    }
  }
  await setStopped(false);
  const id = "task-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const state = {
    id, task: message.task, autonomy: message.autonomy === "autonomous" ? "autonomous" : "supervised",
    tabId: tab.id, provider: info.provider, providerUrl: info.url,
    steps: 0, phase: "starting", startedAt: new Date().toISOString()
  };
  await setActiveTask(id);
  const prompt = message.prompt;
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
  if (state.providerUrl && info.url) {
    try {
      const previous = new URL(state.providerUrl);
      const current = new URL(info.url);
      if (previous.origin !== current.origin || previous.pathname !== current.pathname) {
        throw new Error("Open the original AI conversation URL before resuming this task.");
      }
    } catch (error) {
      if (error.message === "Open the original AI conversation URL before resuming this task.") throw error;
    }
  }
  return { ...state, tabId: tab.id };
}
async function resumeTask(taskId) {
  const state = await readTaskState(taskId);
  if (state?.id) await setActiveTask(state.id);
  if (!state) throw new Error("There is no saved task.");
  await setStopped(false);
  if (state.phase === "response_ready" && state.response) {
    await processModelResponse(state, state.response);
  } else if (state.phase === "paused" && state.resumePhase === "awaiting_model") {
    const attached = await reattachTaskTab(state);
    const resumed = await writeTaskState({ ...attached, phase: "awaiting_model", resumePhase: null });
    try {
      await api.alarms.create("agentos-response-timeout", { delayInMinutes: RESPONSE_TIMEOUT_MINUTES });
      const snapshot = await readProviderMessages(resumed.tabId);
      await handleAssistantSnapshot(resumed.tabId, snapshot.messages, snapshot.url);
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
      await handleAssistantSnapshot(state.tabId, snapshot.messages, snapshot.url);
    } catch (_) {}
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
  if (message?.type === "AGENTOS_TASK_STOP") return setStopped(true).then(async () => {
    const state = await readTaskState();
    if (state && ["awaiting_model", "awaiting_approval", "action_completed"].includes(state.phase)) await writeTaskState({ ...state, phase: "paused", resumePhase: state.phase });
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
    return handleAssistantSnapshot(sender.tab.id, message.messages, message.url).catch(async error => {
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
  const state = await readTaskState();
  if (state?.phase === "awaiting_model") {
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
