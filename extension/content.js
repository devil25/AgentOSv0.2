const api = globalThis.browser;
api.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "AGENTOS_READ_PAGE") return;
  const text = (document.body?.innerText || "").replace(/\n{3,}/g,"\n\n");
  return Promise.resolve({
    ok:true,
    title:document.title,
    url:location.href,
    host:location.hostname,
    text:text.slice(0,12000),
    capturedAt:new Date().toISOString()
  });
});
