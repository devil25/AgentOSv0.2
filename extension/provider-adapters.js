(() => {
  "use strict";

  // Content scripts must use the WebExtension runtime to deliver snapshots
  // to the background task controller.
  const api = globalThis.browser;

  const PROVIDERS = {
    "chat.z.ai": { id: "zai", name: "Z.ai" },
    "chatgpt.com": { id: "chatgpt", name: "ChatGPT" },
    "chat.openai.com": { id: "chatgpt", name: "ChatGPT" },
    "claude.ai": { id: "claude", name: "Claude" },
    "gemini.google.com": { id: "gemini", name: "Gemini" },
    "aistudio.google.com": { id: "google-ai-studio", name: "Google AI Studio" },
    "chat.deepseek.com": { id: "deepseek", name: "DeepSeek" }
  };

  // ChatGPT's current app-shell renderer uses explicit assistant ownership
  // markers that are not covered by the legacy message-author selectors.
  // Keep this list role-specific: generic ".markdown" nodes may belong to user
  // content and must never authorize an AgentOS action.
  const CHATGPT_ASSISTANT_SELECTORS = Object.freeze([
    '[data-message-author-role="assistant"]',
    '[data-role="assistant"]',
    '[data-author="assistant"]',
    '[data-message-role="assistant"]',
    '[data-author-role="assistant"]',
    '[data-turn-role="assistant"]',
    '[data-message-author="assistant"]',
    '[data-conversation-role="assistant"]',
    '[data-turn="assistant"]',
    '[data-testid^="conversation-turn-"][data-turn="assistant"]',
    '[data-test-id^="conversation-turn-"][data-turn="assistant"]',
    'section[data-turn="assistant"]',
    '[data-chatgpt-search-unit-key$=":assistant"]',
    '[data-content-search-unit-key$=":assistant"]',
    '[data-markdown-text-style="assistant-message"]',
  ]);

  // Export the selector contract for Node tests without executing browser code.
  if (typeof module !== "undefined" && module.exports && typeof document === "undefined") {
    module.exports = Object.freeze({ CHATGPT_ASSISTANT_SELECTORS });
    return;
  }

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
    const providerSelectors = {
      chatgpt: ["#prompt-textarea", '[data-testid="prompt-textarea"]'],
      gemini: ['rich-textarea [contenteditable="true"]', '[aria-label*="Enter a prompt" i]'],
      "google-ai-studio": ["ms-prompt-input textarea", "ms-prompt-input [contenteditable='true']", ".ql-editor", "textarea"],
      deepseek: ['textarea[placeholder*="Message" i]', '[contenteditable="true"][data-placeholder]', "textarea"]
    };
    const selectors = [
      ...(providerSelectors[provider?.id] || []),
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

  function hasChatGPTContinuationMarker() {
    if (provider?.id !== "chatgpt") return false;
    const lines = (document.body?.innerText || "")
      .split("\n")
      .map(line => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    return lines.some(line => /^continued from\b/i.test(line));
  }

  function readAssistantResponse() {
    const composer = findComposer();
    const continuationMarker = hasChatGPTContinuationMarker();
    const genericSemanticSelectors = [
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
      '[class*="answer-content" i]',
      "model-response",
      "ms-chat-turn",
      ".turn-content",
      ".ds-markdown",
      '[class*="response-container" i]'
    ];
    const semanticSelectors = provider?.id === "chatgpt"
      ? CHATGPT_ASSISTANT_SELECTORS
      : genericSemanticSelectors;

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
        candidates: semantic.length,
        url: location.href,
        continuationMarker
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
        candidates: blocks.length,
        url: location.href,
        continuationMarker
      };
    }

    const rootText = cleanText(root);
    return {
      ok: true,
      messages: rootText.length >= 24 ? [rootText.slice(-30000)] : [],
      strategy: "conversation root fallback",
      candidates: rootText.length ? 1 : 0,
      url: location.href,
      continuationMarker
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
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true, inputType: "insertText", data: value
      }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (el.isContentEditable) {
      // ChatGPT uses a ProseMirror editor. Mutating its DOM with replaceChildren()
      // bypasses the editor's transaction/state and can leave the Send button
      // looking ready even though the application has not accepted the prompt.
      if (provider?.id === "chatgpt") {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
        const inserted = document.execCommand("insertText", false, value);
        if (!inserted) {
          throw new Error("ChatGPT's editor rejected text insertion; the prompt was not submitted.");
        }
        const actual = (el.innerText || el.textContent || "").replace(/\u00a0/g, " ").trim();
        if (!actual || !actual.includes(value.slice(0, Math.min(80, value.length)))) {
          throw new Error("ChatGPT's editor did not retain the inserted prompt; the prompt was not submitted.");
        }
      } else {
        el.replaceChildren(document.createTextNode(value));
        el.dispatchEvent(new InputEvent("input", {
          bubbles: true, inputType: "insertText", data: value
        }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    } else {
      throw new Error("The detected message composer is not an editable text field.");
    }
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
      const aiStudioRun = provider?.id === "google-ai-studio" && /run/i.test(label);
      return (/send|submit|إرسال/.test(label) || aiStudioRun) &&
        !/stop|cancel|إيقاف/.test(label);
    }) || null;
  }

  async function prepareContinuation() {
    if (provider?.id !== "chatgpt") return { ok: true, handedOff: false, url: location.href };

    const beforeUrl = location.href;
    const buttons = [...document.querySelectorAll("button")].filter(visible);
    let target = null;
    for (const button of buttons) {
      const label = (button.innerText || button.getAttribute("aria-label") || "").trim().toLowerCase();
      if (label !== "new chat") continue;
      let node = button;
      for (let depth = 0; node && depth < 7; depth++, node = node.parentElement) {
        const text = (node.innerText || "").toLowerCase();
        if (text.includes("context window full")) {
          target = button;
          break;
        }
      }
      if (target) break;
    }
    if (!target) return { ok: true, handedOff: false, url: location.href };

    target.click();
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 300));
      const composer = findComposer();
      const modalStillOpen = [...document.querySelectorAll("button")].some(button =>
        visible(button) && (button.innerText || "").trim().toLowerCase() === "new chat" &&
        [...Array(7)].some((_, i) => {
          let node = button;
          for (let j = 0; j < i && node; j++) node = node.parentElement;
          return Boolean(node && (node.innerText || "").toLowerCase().includes("context window full"));
        })
      );
      if (location.href !== beforeUrl && composer && !modalStillOpen) {
        return { ok: true, handedOff: true, url: location.href };
      }
    }
    return { ok: false, handedOff: true, error: "ChatGPT's New chat button was clicked, but the new conversation did not become ready within 30 seconds.", url: location.href };
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
      messageCandidates: response.candidates,
      continuationMarker: response.continuationMarker
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
    const beforeText = (composer.innerText || composer.value || composer.textContent || "").trim();
    if (!beforeText) throw new Error("The message composer is empty; AgentOS will not submit an empty prompt.");
    const beforeMessages = JSON.stringify(readAssistantResponse().messages);
    const button = findSendButton(composer);
    let method = "send-button";
    if (button) {
      button.click();
    } else {
      method = "enter-key-fallback";
      composer.focus();
      composer.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter", code: "Enter", bubbles: true, cancelable: true
      }));
    }

    // A click is not proof that the provider accepted the prompt. Confirm that
    // generation started, the editor cleared, or a new assistant turn appeared.
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 200));
      const currentText = (composer.innerText || composer.value || composer.textContent || "").trim();
      const messagesChanged = JSON.stringify(readAssistantResponse().messages) !== beforeMessages;
      if (generationInProgress() || !currentText || messagesChanged) {
        return { ok: true, submitted: true, verified: true, method };
      }
    }
    throw new Error("The Send control was activated, but the AI website did not confirm submission within 10 seconds. The prompt was not resent.");
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
      return /stop generating|stop response|cancel response|\bstop\b|إيقاف التوليد/.test(label);
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
      try {
        const acknowledgement = await api.runtime.sendMessage({
          type: "AGENTOS_PROVIDER_SNAPSHOT",
          messages: snapshot.messages,
          url: snapshot.url || location.href,
          provider: provider?.id || "unknown",
          strategy: snapshot.strategy,
          continuationMarker: snapshot.continuationMarker
        });
        // Only consume this snapshot after the background confirms acceptance.
        if (acknowledgement?.accepted) {
          lastObservedSignature = signature;
        } else {
          observerTimer = setTimeout(queueAssistantSnapshot, 1200);
        }
      } catch (error) {
        console.warn("[AgentOS] Assistant response delivery failed; retrying.", error);
        observerTimer = setTimeout(queueAssistantSnapshot, 1200);
      }
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

  // Polling fallback catches provider updates when the page reuses existing
  // message nodes and a DOM mutation is not observed.
  setInterval(queueAssistantSnapshot, 3000);

  globalThis.AgentOSProvider = {
    inspect, fillPrompt, submitPrompt, prepareContinuation, readAssistantMessages, readAssistantResponse
  };
})();
