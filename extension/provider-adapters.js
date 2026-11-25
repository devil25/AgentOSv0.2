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
      'textarea',
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

  function readAssistantMessages() {
    const selectors = [
      '[data-message-author-role="assistant"]',
      '[data-testid*="conversation-turn"] [data-message-author-role="assistant"]',
      '[data-testid*="assistant"]',
      '.markdown'
    ];
    const nodes = unique(selectors.flatMap(s => [...document.querySelectorAll(s)]));
    const texts = nodes.map(el => (el.innerText || "").trim())
      .filter(Boolean).filter((value, i, all) => all.indexOf(value) === i);
    return texts.slice(-12);
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
    return {
      ok: true,
      provider: provider?.id || "unknown",
      providerName: provider?.name || "Unsupported AI website",
      url: location.href,
      title: document.title,
      composerAvailable: Boolean(composer),
      assistantMessages: readAssistantMessages()
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

  globalThis.AgentOSProvider = {
    inspect, fillPrompt, submitPrompt, readAssistantMessages
  };
})();
