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
  const CHATGPT_USER_SELECTORS = Object.freeze([
    '[data-message-author-role="user"]',
    '[data-role="user"]',
    '[data-author="user"]',
    '[data-message-role="user"]',
    '[data-author-role="user"]',
    '[data-turn-role="user"]',
    '[data-message-author="user"]',
    '[data-conversation-role="user"]',
    '[data-turn="user"]',
    '[data-testid^="conversation-turn-"][data-turn="user"]',
    '[data-test-id^="conversation-turn-"][data-turn="user"]',
    'section[data-turn="user"]'
  ]);
  const CHATGPT_RESPONSE_BODY_SELECTOR = "[data-response-body]";
  const CHATGPT_MESSAGE_OWNER_SELECTOR = "[data-chatgpt-selection-message-id]";
  const CHATGPT_MESSAGE_SOURCE_SELECTOR = "[data-dil-source-message-id]";
  const CHATGPT_CONVERSATION_ID_SELECTOR = "[data-chatgpt-selection-conversation-id]";

  // A response body, its selection owner and its rendered source must identify
  // the same message. Conflicting IDs mean the DOM relationship is ambiguous.
  function resolveChatGPTMessageId(responseBodyId, selectionMessageId, sourceMessageId) {
    const ids = [responseBodyId, selectionMessageId, sourceMessageId]
      .filter(value => typeof value === "string" && value.trim())
      .map(value => value.trim());
    if (!ids.length || new Set(ids).size !== 1) return null;
    return ids[0];
  }

  function resolveChatGPTConversationId(values) {
    const ids = [...new Set((Array.isArray(values) ? values : []).filter(value => typeof value === "string" && value.trim()).map(value => value.trim()))];
    return ids.length === 1 ? ids[0] : null;
  }

  function isChatGPTContinuationReady(beforeId, currentId, continuationMarker = false) {
    const before = typeof beforeId === "string" ? beforeId.trim() : "";
    const current = typeof currentId === "string" ? currentId.trim() : "";
    if (before) return Boolean(current && current !== before);
    return Boolean(current || continuationMarker === true);
  }

  // Do not mistake unrelated page buttons named "Stop" for a live generation
  // control. Providers expose the active-generation state with more specific labels.
  function isGenerationControlLabel(value) {
    return /stop\s*(?:generating|response|generation|streaming)|stop[-_](?:generating|response|generation|button)|cancel\s*(?:response|generation)|cancel[-_](?:response|generation)|إيقاف\s*(?:التوليد|الاستجابة)/i.test(String(value || ""));
  }

  function normalizeMessageText(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }
  
  function isChatGPTNewChatButtonLabel(value) {
    return /^new chat(?:\b|$)/i.test(normalizeMessageText(value));
  }

  function hasNewUserMessage(currentMessages, baselineMessages, submittedText) {
    const promptPrefix = normalizeMessageText(submittedText).slice(0, 80);
    if (promptPrefix.length < 12 || !Array.isArray(currentMessages)) return false;

    const baselineCounts = new Map();
    for (const message of Array.isArray(baselineMessages) ? baselineMessages : []) {
      const normalized = normalizeMessageText(message);
      if (normalized) baselineCounts.set(normalized, (baselineCounts.get(normalized) || 0) + 1);
    }

    for (const message of currentMessages) {
      const normalized = normalizeMessageText(message);
      if (!normalized || !normalized.includes(promptPrefix)) continue;
      const count = baselineCounts.get(normalized) || 0;
      if (count > 0) baselineCounts.set(normalized, count - 1);
      else return true;
    }
    return false;
  }

  // Export the selector/identity contract for Node tests without executing browser code.
  if (typeof module !== "undefined" && module.exports && typeof document === "undefined") {
    module.exports = Object.freeze({
      CHATGPT_ASSISTANT_SELECTORS,
      CHATGPT_USER_SELECTORS,
      CHATGPT_RESPONSE_BODY_SELECTOR,
      CHATGPT_MESSAGE_OWNER_SELECTOR,
      CHATGPT_MESSAGE_SOURCE_SELECTOR,
      CHATGPT_CONVERSATION_ID_SELECTOR,
      resolveChatGPTMessageId,
      resolveChatGPTConversationId,
      isChatGPTContinuationReady,
      isGenerationControlLabel,
      hasNewUserMessage,
      isChatGPTNewChatButtonLabel
    });
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

  function readUserMessages(composer) {
    const selectors = provider?.id === "chatgpt"
      ? CHATGPT_USER_SELECTORS
      : [
          '[data-message-author-role="user"]',
          '[data-role="user"]',
          '[data-author="user"]',
          '[data-message-role="user"]'
        ];
    const nodes = selectors.flatMap(selector => {
      try { return [...document.querySelectorAll(selector)]; }
      catch (_) { return []; }
    });
    return compactCandidates(nodes, composer).map(row => row.text);
  }

  function readChatGPTAssistantEntries(composer) {
    const bodies = unique([...document.querySelectorAll(CHATGPT_RESPONSE_BODY_SELECTOR)])
      .filter(body => !isInsideComposer(body, composer));
    const entries = [];

    for (const body of bodies) {
      // The role marker is the authority. data-response-body alone is only a
      // boundary and must never be treated as proof that the author is ChatGPT.
      const assistantNodes = [...body.querySelectorAll('[data-markdown-text-style="assistant-message"]')]
        .filter(visible);
      if (!assistantNodes.length) continue;

      const responseBodyId = body.getAttribute("data-response-body");
      for (const node of assistantNodes) {
        const owner = node.closest(CHATGPT_MESSAGE_OWNER_SELECTOR);
        const source = node.querySelector(CHATGPT_MESSAGE_SOURCE_SELECTOR) ||
          body.querySelector(CHATGPT_MESSAGE_SOURCE_SELECTOR);
        const messageId = resolveChatGPTMessageId(
          responseBodyId,
          owner?.getAttribute("data-chatgpt-selection-message-id"),
          source?.getAttribute("data-dil-source-message-id")
        );
        if (!messageId) continue;

        const text = cleanText(node);
        if (text.length < 12 || text.length > 30000) continue;

        const existing = entries.find(entry => entry.id === messageId);
        if (existing) existing.text = text;
        else entries.push({ id: messageId, text });
      }
    }
    return entries;
  }

  function getChatGPTConversationId() {
    if (provider?.id !== "chatgpt") return null;
    // ChatGPT may keep a hidden stale conversation shell in the DOM while
    // rendering the active conversation. Only visible, connected elements
    // may contribute an identity; conflicting visible identities still fail
    // closed in resolveChatGPTConversationId().
    const values = [...document.querySelectorAll(CHATGPT_CONVERSATION_ID_SELECTOR)]
      .filter(visible)
      .map(node => node.getAttribute("data-chatgpt-selection-conversation-id"));
    return resolveChatGPTConversationId(values);
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
    const conversationId = getChatGPTConversationId();

    // New ChatGPT app-shell DOM: data-response-body provides the message
    // boundary; the nested assistant-message marker proves authorship; the
    // three matching IDs prevent mixing content from adjacent turns.
    if (provider?.id === "chatgpt") {
      const entries = readChatGPTAssistantEntries(composer);
      if (entries.length) {
        const latest = entries.slice(-12);
        return {
          ok: true,
          messages: latest.map(entry => entry.text),
          messageIds: latest.map(entry => entry.id),
          strategy: "semantic selectors",
          candidates: entries.length,
          url: location.href,
          conversationId,
          continuationMarker
        };
      }
    }

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
        messageIds: [],
        strategy: "semantic selectors",
        candidates: semantic.length,
        url: location.href,
        conversationId,
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
        conversationId,
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
      conversationId,
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
    const beforeConversationId = getChatGPTConversationId();
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
      const currentConversationId = getChatGPTConversationId();
      const identityReady = isChatGPTContinuationReady(
        beforeConversationId,
        currentConversationId,
        hasChatGPTContinuationMarker()
      );
      if (location.href !== beforeUrl && composer && !modalStillOpen && identityReady) {
        return {
          ok: true,
          handedOff: true,
          url: location.href,
          conversationId: currentConversationId,
          continuationMarker: hasChatGPTContinuationMarker()
        };
      }
    }
    return {
      ok: false,
      handedOff: true,
      error: "ChatGPT's New chat button was clicked, but the new conversation identity did not become ready within 30 seconds.",
      url: location.href,
      conversationId: getChatGPTConversationId()
    };
  }

  async function inspect() {
    const composer = findComposer();
    const response = readAssistantResponse();
    return {
      ok: true,
      provider: provider?.id || "unknown",
      providerName: provider?.name || "Unsupported AI website",
      url: location.href,
      conversationId: response.conversationId,
      title: document.title,
      composerAvailable: Boolean(composer),
      assistantMessages: response.messages,
      readStrategy: response.strategy,
      messageCandidates: response.candidates,
      continuationMarker: response.continuationMarker,
      generationInProgress: generationInProgress()
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
    const beforeUserMessages = readUserMessages(composer);
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

    // ChatGPT may replace its ProseMirror composer after accepting a message.
    // Re-query the live editor instead of reading a stale detached DOM node.
    // A newly rendered user turn confirms acceptance without waiting for the
    // assistant to finish generating a response.
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 200));
      const currentComposer = findComposer();
      const currentText = currentComposer
        ? (currentComposer.innerText || currentComposer.value || currentComposer.textContent || "").trim()
        : null;
      const messagesChanged = JSON.stringify(readAssistantResponse().messages) !== beforeMessages;
      const newUserTurn = hasNewUserMessage(
        readUserMessages(currentComposer || composer),
        beforeUserMessages,
        beforeText
      );
      const composerCleared = currentComposer !== null && currentText === "";
      const generationActive = generationInProgress();
      if (generationActive || composerCleared || newUserTurn || messagesChanged) {
        return {
          ok: true,
          submitted: true,
          verified: true,
          method,
          confirmation: generationActive ? "generation-control" :
            composerCleared ? "composer-cleared" :
            newUserTurn ? "new-user-message" : "assistant-message-changed"
        };
      }
    }
    throw new Error("The Send control was activated, but AgentOS could not verify that ChatGPT accepted the prompt within 20 seconds. The prompt may already be present in the conversation; it was not resent. Inspect the conversation before retrying.");
  }

  // Record an explicit user click on ChatGPT's New chat control. The background
  // controller only treats it as a handoff when this tab owns an unfinished task.
  if (provider?.id === "chatgpt") {
    document.addEventListener("click", event => {
      if (!event.isTrusted) return;
      const origin = event.target instanceof Element ? event.target : event.target?.parentElement;
      const target = origin?.closest?.("button, [role='button'], a");
      if (!target || !visible(target)) return;
      const label = [
        target.innerText, target.getAttribute("aria-label"),
        target.getAttribute("data-testid"), target.title
      ].filter(Boolean).join(" ");
      if (!isChatGPTNewChatButtonLabel(label)) return;
      try {
        Promise.resolve(api.runtime.sendMessage({
          type: "AGENTOS_CHATGPT_NEW_CHAT_CLICKED",
          fromUrl: location.href,
          fromConversationId: getChatGPTConversationId(),
          clickedAt: new Date().toISOString()
        })).catch(() => {});
      } catch (_) {}
    }, true);
  }

  // Observe the provider page independently of the sidebar lifetime. A quiet,
  // stable assistant response is forwarded to the background task controller.
  let observerTimer = null;
  let lastObservedSignature = "";
  let stableSignature = "";
  let stableCount = 0;
  function generationInProgress() {
    const controls = [...document.querySelectorAll("button, [role='button']")];
    return controls.some(button => {
      if (!button?.isConnected) return false;
      const style = getComputedStyle(button);
      const rect = button.getBoundingClientRect();
      if (style.visibility === "hidden" || style.display === "none" ||
          rect.width <= 0 || rect.height <= 0) return false;
      const label = [
        button.innerText, button.getAttribute("aria-label"),
        button.getAttribute("data-testid"), button.getAttribute("data-test-id"),
        button.title
      ].join(" ");
      return isGenerationControlLabel(label);
    });
  }
  function queueAssistantSnapshot() {
    if (observerTimer) clearTimeout(observerTimer);
    observerTimer = setTimeout(async () => {
      const snapshot = readAssistantResponse();
      if (!snapshot.ok || !snapshot.messages.length) return;
      const signature = JSON.stringify({
        messageIds: snapshot.messageIds || [],
        messages: snapshot.messages
      });
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
          messageIds: snapshot.messageIds || [],
          url: snapshot.url || location.href,
          conversationId: snapshot.conversationId || null,
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
