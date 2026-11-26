(() => {
  "use strict";

  function normalizeIdentity(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  function chatGPTConversationIdentityMatches(state, conversationId) {
    if (state?.provider !== "chatgpt") return false;
    const currentId = normalizeIdentity(conversationId);
    if (!currentId) return false;
    const savedId = normalizeIdentity(state.providerConversationId);
    if (savedId) return savedId === currentId;

    try {
      const parsed = new URL(state.providerUrl);
      const match = decodeURIComponent(parsed.pathname).match(/^\/c\/(local-chatgpt:.+)$/i);
      return Boolean(match && match[1] === currentId);
    } catch (_) {
      return false;
    }
  }

  function sameConversation(state, provider, url, conversationId = null) {
    if (state?.provider !== provider) return false;
    const savedId = provider === "chatgpt" ? normalizeIdentity(state.providerConversationId) : null;
    const currentId = provider === "chatgpt" ? normalizeIdentity(conversationId) : null;

    // Conflicting, known DOM identities are authoritative: never match by URL.
    if (savedId && currentId && savedId !== currentId) return false;

    // A missing DOM marker is transient on the ChatGPT SPA. If the URL still
    // identifies the same conversation, keep the task attached.
    if (state.providerUrl && url) {
      try {
        const oldUrl = new URL(state.providerUrl);
        const newUrl = new URL(url);
        if (oldUrl.origin === newUrl.origin && oldUrl.pathname === newUrl.pathname) return true;
      } catch (_) {
        if (state.providerUrl === url) return true;
      }
    } else if (state.providerUrl === url) {
      return true;
    }

    // A verified DOM ID remains valid across URL migrations.
    return provider === "chatgpt" && chatGPTConversationIdentityMatches(state, conversationId);
  }

  function isChatGPTContinuationUrl(provider, url) {
    if (provider !== "chatgpt" || !url) return false;
    try {
      const parsed = new URL(url);
      const path = decodeURIComponent(parsed.pathname);
      return ["chatgpt.com", "chat.openai.com"].includes(parsed.hostname) &&
        /^\/c\/local-chatgpt:/i.test(path);
    } catch (_) {
      return false;
    }
  }

  function applyChatGPTHandoff(state, handoff, at = new Date().toISOString()) {
    if (state?.provider !== "chatgpt" || handoff?.handedOff !== true ||
        typeof handoff.url !== "string" || !handoff.url.trim()) {
      throw new Error("A verified ChatGPT handoff is required.");
    }
    const nextConversationId = normalizeIdentity(handoff.conversationId);
    return {
      ...state,
      tabId: state.tabId,
      providerUrl: handoff.url,
      providerConversationId: nextConversationId,
      conversationTransfer: {
        ...(state.conversationTransfer || {}),
        from: state.providerUrl,
        to: handoff.url,
        observedUrl: handoff.url,
        fromConversationId: normalizeIdentity(state.providerConversationId),
        toConversationId: nextConversationId,
        at,
        method: "chatgpt-context-window-new-chat"
      }
    };
  }

  const api = Object.freeze({
    chatGPTConversationIdentityMatches,
    sameConversation,
    isChatGPTContinuationUrl,
    applyChatGPTHandoff
  });
  globalThis.AgentOSConversationIdentity = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
