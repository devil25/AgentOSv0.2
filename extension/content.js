const api = globalThis.browser;

api.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "AGENTOS_READ_PAGE") {
    const text = (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n");
    return Promise.resolve({
      ok: true, title: document.title, url: location.href,
      host: location.hostname, text: text.slice(0, 12000),
      capturedAt: new Date().toISOString()
    });
  }

  const adapter = globalThis.AgentOSProvider;
  if (!adapter) return undefined;
  if (msg?.type === "AGENTOS_PROVIDER_INSPECT") return adapter.inspect();
  if (msg?.type === "AGENTOS_PROVIDER_FILL") return adapter.fillPrompt(msg.prompt);
  if (msg?.type === "AGENTOS_PROVIDER_SUBMIT") return adapter.submitPrompt();
  if (msg?.type === "AGENTOS_PROVIDER_READ") {
    return Promise.resolve({ok:true, messages:adapter.readAssistantMessages()});
  }
  return undefined;
});
