const api = globalThis.browser;
let stopped = false;
const TASK_STATE_KEY = "agentos.taskState";

async function readTaskState() {
  const stored = await api.storage.local.get(TASK_STATE_KEY);
  return stored[TASK_STATE_KEY] || null;
}
async function writeTaskState(state) {
  await api.storage.local.set({ [TASK_STATE_KEY]: state });
  return { ok: true };
}


api.action.onClicked.addListener(async () => {
  try {
    await api.sidebarAction.open();
  } catch (error) {
    console.error("AgentOS sidebar:", error);
  }
});

api.runtime.onMessage.addListener((message) => {
  if (message?.type === "AGENTOS_NATIVE_REQUEST") return nativeRequest(message.payload);
  if (message?.type === "AGENTOS_TASK_STATE_GET") return readTaskState().then(state => ({ ok: true, state }));
  if (message?.type === "AGENTOS_TASK_STATE_SET") return writeTaskState(message.state);
  if (message?.type === "AGENTOS_SET_STOP") {
    stopped = Boolean(message.value);
    return api.storage.local.set({ "agentos.stopped": stopped }).then(() => ({ ok: true, stopped }));
  }
  if (message?.type === "AGENTOS_GET_STOP") return api.storage.local.get("agentos.stopped").then(value => { stopped = Boolean(value["agentos.stopped"]); return { stopped }; });
  if (message?.type === "AGENTOS_OPEN_URL") return openSafeUrl(message.url);
  if (message?.type === "AGENTOS_PAGE_INFO") return getPageInfo();
  if (message?.type === "AGENTOS_PROVIDER_INSPECT") return providerRequest("AGENTOS_PROVIDER_INSPECT");
  if (message?.type === "AGENTOS_PROVIDER_READ") return providerRequest("AGENTOS_PROVIDER_READ");
  if (message?.type === "AGENTOS_PROVIDER_FILL") {
    if (stopped) return { ok: false, error: "AgentOS is stopped" };
    return providerRequest("AGENTOS_PROVIDER_FILL", { prompt: message.prompt });
  }
  if (message?.type === "AGENTOS_PROVIDER_SUBMIT") {
    if (stopped) return { ok: false, error: "AgentOS is stopped" };
    return providerRequest("AGENTOS_PROVIDER_SUBMIT");
  }
});

async function nativeRequest(payload) {
  if (stopped && payload?.type !== "runtime.status") {
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

    timer = setTimeout(() => finish({ ok: false, error: "Native host timeout" }), 15000);
    port.onMessage.addListener((response) => finish(response));
    port.onDisconnect.addListener(() => finish({
      ok: false,
      error: api.runtime.lastError?.message || "Native host disconnected"
    }));

    port.postMessage({ protocol: "agentos.v1", ...payload });
  });
}

async function activeTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");
  return tab;
}

async function providerRequest(type, extra = {}) {
  const tab = await activeTab();
  try {
    return await api.tabs.sendMessage(tab.id, { type, ...extra });
  } catch (_) {
    return {
      ok: false,
      error: "Open Z.ai, ChatGPT, Claude, or Gemini in the active tab first."
    };
  }
}

async function openSafeUrl(raw) {
  if (stopped) {
    return { ok: false, error: "AgentOS is stopped. Resume it before opening a URL." };
  }
  try {
    if (typeof raw !== "string" || !raw.trim() || raw.length > 4096) {
      throw new Error("URL must be text under 4096 characters");
    }
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("Only http/https URLs are allowed");
    }
    if (url.username || url.password) {
      throw new Error("URLs containing embedded credentials are not allowed");
    }
    const tab = await api.tabs.create({ url: url.href, active: true });
    return { ok: true, tabId: tab.id, url: url.href };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

async function getPageInfo() {
  const tab = await activeTab();
  try {
    return await api.tabs.sendMessage(tab.id, { type: "AGENTOS_READ_PAGE" });
  } catch (_) {
    return {
      ok: false,
      error: "This page is not accessible to AgentOS. Open a supported AI website or a normal http/https page."
    };
  }
}
