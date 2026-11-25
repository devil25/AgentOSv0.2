const api = globalThis.browser;
let stopped = false;

api.action.onClicked.addListener(async () => {
  try { await api.sidebarAction.open(); }
  catch (e) { console.error("AgentOS sidebar:", e); }
});

api.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "AGENTOS_NATIVE_REQUEST") return nativeRequest(msg.payload);
  if (msg?.type === "AGENTOS_SET_STOP") {
    stopped = Boolean(msg.value);
    return Promise.resolve({ok:true, stopped});
  }
  if (msg?.type === "AGENTOS_GET_STOP") return Promise.resolve({stopped});
  if (msg?.type === "AGENTOS_OPEN_URL") return openSafeUrl(msg.url);
  if (msg?.type === "AGENTOS_PAGE_INFO") return getPageInfo();
  if (msg?.type === "AGENTOS_PROVIDER_INSPECT") return providerRequest("AGENTOS_PROVIDER_INSPECT");
  if (msg?.type === "AGENTOS_PROVIDER_READ") return providerRequest("AGENTOS_PROVIDER_READ");
  if (msg?.type === "AGENTOS_PROVIDER_FILL") {
    if (stopped) return {ok:false,error:"AgentOS is stopped"};
    return providerRequest("AGENTOS_PROVIDER_FILL", {prompt:msg.prompt});
  }
  if (msg?.type === "AGENTOS_PROVIDER_SUBMIT") {
    if (stopped) return {ok:false,error:"AgentOS is stopped"};
    return providerRequest("AGENTOS_PROVIDER_SUBMIT");
  }
});

async function nativeRequest(payload) {
  if (stopped && payload?.type !== "runtime.status") {
    return {ok:false, error:"AgentOS is stopped. Resume it before running actions."};
  }
  return new Promise((resolve) => {
    let port, done=false, timer;
    const finish = (value) => {
      if (done) return;
      done=true; clearTimeout(timer);
      try { port?.disconnect(); } catch (_) {}
      resolve(value);
    };
    try { port = api.runtime.connectNative("com.agentos.host"); }
    catch (e) { finish({ok:false,error:String(e)}); return; }
    timer=setTimeout(()=>finish({ok:false,error:"Native host timeout"}),15000);
    port.onMessage.addListener((response)=>finish(response));
    port.onDisconnect.addListener(()=>finish({ok:false,error:api.runtime.lastError?.message || "Native host disconnected"}));
    port.postMessage({protocol:"agentos.v1", ...payload});
  });
}

async function activeTab() {
  const [tab] = await api.tabs.query({active:true,currentWindow:true});
  if (!tab?.id) throw new Error("No active tab");
  return tab;
}

async function providerRequest(type, extra={}) {
  const tab = await activeTab();
  try {
    return await api.tabs.sendMessage(tab.id,{type,...extra});
  } catch (e) {
    return {ok:false,error:"Open Z.ai, ChatGPT, Claude, or Gemini in the active tab first."};
  }
}

async function openSafeUrl(raw) {
  if (stopped) return {ok:false,error:"AgentOS is stopped. Resume it before opening a URL."};
  try {
    const u = new URL(raw);
    if (!["http:","https:"].includes(u.protocol)) throw new Error("Only http/https URLs are allowed");
    const tab = await api.tabs.create({url:u.href, active:true});
    return {ok:true, tabId:tab.id, url:u.href};
  } catch(e) { return {ok:false,error:String(e.message || e)}; }
}

async function getPageInfo() {
  const tab = await activeTab();
  try { return await api.tabs.sendMessage(tab.id,{type:"AGENTOS_READ_PAGE"}); }
  catch(e) { return {ok:false,error:"This page is not accessible to AgentOS. Open a supported AI website or a normal http/https page."}; }
}
