(() => {
  "use strict";

  const PROVIDERS = {
    "chat.z.ai": { id: "zai", name: "Z.ai" },
    "chatgpt.com": { id: "chatgpt", name: "ChatGPT" },
    "chat.openai.com": { id: "chatgpt", name: "ChatGPT" },
    "claude.ai": { id: "claude", name: "Claude" },
    "gemini.google.com": { id: "gemini", name: "Gemini" }
  };

  const host = location.hostname;
  const provider = PROVIDERS[host] || Object.entries(PROVIDERS)
    .find(([domain]) => host.endsWith("." + domain))?.[1] || null;

  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" &&
      rect.width > 0 && rect.height > 0 && !el.disabled && !el.readOnly;
  };

  const unique = (items) => [...new Set(items)].filter(visible);

  function findComposer() {
    const selectors = [
      "textarea",
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"]',
      '[role="textbox"]'
    ];
    const candidates = unique(selectors.flatMap(s => [...document.querySelectorAll(s)]));
    const preferred = candidates.find(el => {
      const text = [
        el.getAttribute("placeholder"), el.getAttribute("aria-label"),
        el.getAttribute("data-placeholder"), el.getAttribute("name")
      ].join(" ").toLowerCase();
      return /message|prompt|ask|send|اكتب|رسالة|اسأل/.test(text);
    });
    return preferred || candidates.at(-1) || null;
  }

  function cleanText(el) {
    if (!el) return "";
    const clone = el.cloneNode(true);
    clone.querySelectorAll(
      "button, input, textarea, select, [contenteditable='true'], nav, header, footer, aside, [aria-hidden='true']"
    ).forEach(node => node.remove());
    return (clone.innerText || clone.textContent || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function isInsideComposer(el, composer) {
    return Boolean(composer && (el === composer || el.contains(composer) || composer.contains(el)));
  }

  function compactCandidates(nodes, composer) {
    const rows = unique(nodes)
      .filter(el => !isInsideComposer(el, composer))
      .map(el => ({ el, text: cleanText(el) }))
      .filter(x => x.text.length >= 12 && x.text.length <= 30000);

    // Keep the most informative node when selectors match nested wrappers.
    const result = [];
    for (const row of rows) {
      const existing = result.find(x => x.text === row.text);
      if (existing) {
        if (row.el.contains(existing.el)) Object.assign(existing, row);
        continue;
      }
      const parent = result.find(x => x.el.contains(row.el));
      if (parent && parent.text.length >= row.text.length) continue;
      for (let i = result.length - 1; i >= 0; i--) {
        if (row.el.contains(result[i].el)) result.splice(i, 1);
      }
      result.push(row);
    }
    return result;
  }

  function readAssistantResponse() {
    const composer = findComposer();
    const semanticSelectors = [
      '[data-message-author-role="assistant"]',
      '[data-role="assistant"]',
      '[data-author="assistant"]',
      '[data-message-role="assistant"]',
      '[aria-label*="assistant" i]',
      '[data-testid*="assistant" i]',
      '[class*="assistant-message" i]',
      '[class*="message-assistant" i]',
      '[class*="chat-message" i]',
      '[class*="message-content" i]',
      '[class*="markdown" i]',
      '[class*="prose" i]',
      '[class*="response-content" i]',
      '[class*="answer-content" i]'
    ];

    const semantic = compactCandidates(
      semanticSelectors.flatMap(selector => {
        try { return [...document.querySelectorAll(selector)]; }
        catch (_) { return []; }
      }),
      composer
    );

    if (semantic.length) {
      return {
        ok: true,
        messages: semantic.slice(-12).map(x => x.text),
        strategy: "semantic selectors",
        candidates: semantic.length
      };
    }

    // Fallback for sites (including changing Z.ai layouts) that do not expose
    // stable assistant attributes: inspect only the visible conversation region.
    const roots = unique([
      ...document.querySelectorAll('main, [role="main"], [class*="conversation" i], [class*="chat-content" i], [class*="chat-container" i]')
    ]).filter(el => el !== composer && !(composer && composer.contains(el)));
    const root = roots.sort((a, b) => cleanText(a).length - cleanText(b).length)[0] ||
      document.body;

    const blockSelectors = [
      "p", "li", "pre", "blockquote", "h1", "h2", "h3",
      '[role="paragraph"]',
      '[class*="message" i]',
      '[class*="markdown" i]',
      '[class*="prose" i]',
      "main > div > div"
    ];
    const blocks = compactCandidates(
      blockSelectors.flatMap(selector => {
        try { return [...root.querySelectorAll(selector)]; }
        catch (_) { return []; }
      }),
      composer
    ).filter(x => x.text.length >= 24);

    if (blocks.length) {
      return {
        ok: true,
        messages: blocks.slice(-16).map(x => x.text),
        strategy: "conversation text-block fallback",
        candidates: blocks.length
      };
    }

    const rootText = cleanText(root);
    return {
      ok: true,
      messages: rootText.length >= 24 ? [rootText.slice(-30000)] : [],
      strategy: "conversation root fallback",
      candidates: rootText.length ? 1 : 0
    };
  }

  function readAssistantMessages() {
    return readAssistantResponse().messages;
  }

  function setComposerText(el, value) {
    el.focus();
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(el), "value"
      )?.set;
      if (setter) setter.call(el, value);
      else el.value = value;
    } else {
      el.replaceChildren(document.createTextNode(value));
    }
    el.dispatchEvent(new InputEvent("input", {
      bubbles: true, inputType: "insertText", data: value
    }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function findSendButton(composer) {
    const form = composer?.closest("form") || composer?.parentElement?.parentElement;
    const candidates = unique([
      ...(form ? form.querySelectorAll("button") : []),
      ...document.querySelectorAll("button")
    ]);
    return candidates.find(button => {
      const label = [
        button.innerText, button.getAttribute("aria-label"),
        button.getAttribute("data-testid"), button.title
      ].join(" ").toLowerCase();
      return /send|submit|إرسال/.test(label) &&
        !/stop|cancel|إيقاف/.test(label);
    }) || null;
  }

  async function inspect() {
    const composer = findComposer();
    const response = readAssistantResponse();
    return {
      ok: true,
      provider: provider?.id || "unknown",
      providerName: provider?.name || "Unsupported AI website",
      url: location.href,
      title: document.title,
      composerAvailable: Boolean(composer),
      assistantMessages: response.messages,
      readStrategy: response.strategy,
      messageCandidates: response.candidates
    };
  }

  async function fillPrompt(prompt) {
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 50000) {
      throw new Error("Prompt must be non-empty text under 50 KB");
    }
    const composer = findComposer();
    if (!composer) throw new Error("Could not find the message composer on this page");
    setComposerText(composer, prompt);
    return { ok: true, provider: provider?.id || "unknown", filled: true, submitted: false };
  }

  async function submitPrompt() {
    const composer = findComposer();
    if (!composer) throw new Error("Could not find the message composer on this page");
    const button = findSendButton(composer);
    if (button) {
      button.click();
      return { ok: true, submitted: true, method: "send-button" };
    }
    composer.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", code: "Enter", bubbles: true, cancelable: true
    }));
    return { ok: true, submitted: true, method: "enter-key-fallback" };
  }

  // Observe the provider page independently of the sidebar lifetime. A quiet,
  // stable assistant response is forwarded to the background task controller.
  let observerTimer = null;
  let lastObservedSignature = "";
  let stableSignature = "";
  let stableCount = 0;
  function generationInProgress() {
    const controls = [...document.querySelectorAll("button")];
    return controls.some(button => {
      if (!visible(button)) return false;
      const label = [
        button.innerText, button.getAttribute("aria-label"),
        button.getAttribute("data-testid"), button.title
      ].join(" ").toLowerCase();
      return /stop generating|stop response|cancel response|\\bstop\\b|إيقاف التوليد/.test(label);
    });
  }
  function queueAssistantSnapshot() {
    if (observerTimer) clearTimeout(observerTimer);
    observerTimer = setTimeout(async () => {
      const snapshot = readAssistantResponse();
      if (!snapshot.ok || !snapshot.messages.length) return;
      const signature = JSON.stringify(snapshot.messages);
      if (signature === lastObservedSignature) return;
      if (signature === stableSignature) stableCount += 1;
      else { stableSignature = signature; stableCount = 0; }
      if (generationInProgress() || stableCount < 1) {
        queueAssistantSnapshot();
        return;
      }
      lastObservedSignature = signature;
      try {
        await api.runtime.sendMessage({
          type: "AGENTOS_PROVIDER_SNAPSHOT",
          messages: snapshot.messages,
          strategy: snapshot.strategy
        });
      } catch (_) {}
    }, 1500);
  }
  const conversationObserver = new MutationObserver(queueAssistantSnapshot);
  const beginObserving = () => {
    if (!document.body || document.documentElement.dataset.agentosObserver === "active") return;
    document.documentElement.dataset.agentosObserver = "active";
    conversationObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  };
  if (document.body) beginObserving();
  else document.addEventListener("DOMContentLoaded", beginObserving, { once: true });

  globalThis.AgentOSProvider = {
    inspect, fillPrompt, submitPrompt, readAssistantMessages, readAssistantResponse
  };
})();
