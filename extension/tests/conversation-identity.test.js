const test = require("node:test");
const assert = require("node:assert/strict");
const {
  chatGPTConversationIdentityMatches,
  sameConversation,
  isChatGPTContinuationUrl,
  applyChatGPTHandoff
} = require("../conversation-identity.js");

test("matches a ChatGPT conversation across URL changes when its DOM identity is stable", () => {
  const state = {
    provider: "chatgpt",
    providerUrl: "https://chatgpt.com/c/local-chatgpt:conversation-1",
    providerConversationId: "conversation-1"
  };
  assert.equal(sameConversation(state, "chatgpt", "https://chatgpt.com/c/renamed-route", "conversation-1"), true);
});

test("rejects conflicting known ChatGPT identities even when the URL is identical", () => {
  const state = {
    provider: "chatgpt",
    providerUrl: "https://chatgpt.com/c/local-chatgpt:conversation-1",
    providerConversationId: "conversation-1"
  };
  assert.equal(sameConversation(state, "chatgpt", state.providerUrl, "conversation-2"), false);
});

test("keeps the task attached when ChatGPT temporarily omits the DOM identity but the URL is unchanged", () => {
  const state = {
    provider: "chatgpt",
    providerUrl: "https://chatgpt.com/c/local-chatgpt:conversation-1",
    providerConversationId: "conversation-1"
  };
  assert.equal(sameConversation(state, "chatgpt", state.providerUrl, null), true);
});

test("does not accept a different ChatGPT URL when the current DOM identity is missing", () => {
  const state = {
    provider: "chatgpt",
    providerUrl: "https://chatgpt.com/c/local-chatgpt:conversation-1",
    providerConversationId: "conversation-1"
  };
  assert.equal(sameConversation(state, "chatgpt", "https://chatgpt.com/c/unknown-new-chat", null), false);
});

test("recognizes legacy local-chatgpt URL identities", () => {
  const state = { provider: "chatgpt", providerUrl: "https://chatgpt.com/c/local-chatgpt:legacy-42" };
  assert.equal(chatGPTConversationIdentityMatches(state, "local-chatgpt:legacy-42"), true);
  assert.equal(chatGPTConversationIdentityMatches(state, "local-chatgpt:other"), false);
});

test("recognizes continuation URLs only for supported ChatGPT hosts and paths", () => {
  assert.equal(isChatGPTContinuationUrl("chatgpt", "https://chatgpt.com/c/local-chatgpt:abc"), true);
  assert.equal(isChatGPTContinuationUrl("chatgpt", "https://chat.openai.com/c/local-chatgpt:abc"), true);
  assert.equal(isChatGPTContinuationUrl("chatgpt", "https://example.com/c/local-chatgpt:abc"), false);
  assert.equal(isChatGPTContinuationUrl("claude", "https://chatgpt.com/c/local-chatgpt:abc"), false);
});

test("persists the new DOM identity returned by an automatic handoff", () => {
  const oldState = {
    id: "task-1", provider: "chatgpt", tabId: 7,
    providerUrl: "https://chatgpt.com/c/old",
    providerConversationId: "old-conversation"
  };
  const next = applyChatGPTHandoff(oldState, {
    ok: true,
    handedOff: true,
    contextWindowFullObserved: true,
    triggerReason: "chatgpt-context-window-full",
    fromUrl: "https://chatgpt.com/c/old",
    toUrl: "https://chatgpt.com/c/new",
    fromConversationId: "old-conversation",
    toConversationId: "new-conversation",
    url: "https://chatgpt.com/c/new",
    conversationId: "new-conversation",
    continuationMarker: false,
    verification: "context-window-trigger-and-conversation-id-change"
  }, "2026-11-26T10:00:00.000Z");
  assert.equal(next.providerUrl, "https://chatgpt.com/c/new");
  assert.equal(next.providerConversationId, "new-conversation");
  assert.equal(next.conversationTransfer.fromConversationId, "old-conversation");
  assert.equal(next.conversationTransfer.toConversationId, "new-conversation");
  assert.equal(next.handoffEvents.length, 1);
  assert.equal(next.handoffEvents[0].taskId, "task-1");
  assert.equal(next.handoffEvents[0].fromConversationId, "old-conversation");
  assert.equal(next.handoffEvents[0].toConversationId, "new-conversation");
  assert.equal(next.handoffEvents[0].triggerReason, "chatgpt-context-window-full");
});

test("accepts a same-identity context handoff only with the explicit continuation marker", () => {
  const state = {
    id: "task-2", provider: "chatgpt", tabId: 9,
    providerUrl: "https://chatgpt.com/c/local-chatgpt:same",
    providerConversationId: "local-chatgpt:same",
    stageLedger: { "8": { number: 8, status: "passed" } }
  };
  const next = applyChatGPTHandoff(state, {
    ok: true, handedOff: true, contextWindowFullObserved: true,
    triggerReason: "chatgpt-context-window-full",
    fromUrl: state.providerUrl, toUrl: state.providerUrl,
    fromConversationId: "local-chatgpt:same",
    toConversationId: "local-chatgpt:same",
    url: state.providerUrl, conversationId: "local-chatgpt:same",
    continuationMarker: true, verification: "continued-from-marker"
  }, "2026-11-26T11:00:00.000Z");
  assert.equal(next.providerConversationId, "local-chatgpt:same");
  assert.equal(next.handoffEvents[0].continuationMarker, true);
  assert.equal(next.handoffEvents[0].resumedStageNumber, 9);
});

test("rejects same-identity handoff claims without the continuation marker", () => {
  const url = "https://chatgpt.com/c/local-chatgpt:same";
  assert.throws(() => applyChatGPTHandoff({
    provider: "chatgpt", providerUrl: url, providerConversationId: "local-chatgpt:same"
  }, {
    ok: true, handedOff: true, contextWindowFullObserved: true,
    triggerReason: "chatgpt-context-window-full",
    fromUrl: url, toUrl: url,
    fromConversationId: "local-chatgpt:same",
    toConversationId: "local-chatgpt:same",
    url, conversationId: "local-chatgpt:same",
    continuationMarker: false
  }), /continuation marker or changed conversation identity/);
});

test("rejects handoff claims without context-window trigger evidence", () => {
  assert.throws(() => applyChatGPTHandoff({
    provider: "chatgpt", providerUrl: "https://chatgpt.com/c/old"
  }, {
    ok: true, handedOff: true, url: "https://chatgpt.com/c/new",
    conversationId: "new"
  }), /verified ChatGPT context-window handoff/);
});

test("never carries the old ChatGPT identity when the handoff cannot provide a new one", () => {
  const next = applyChatGPTHandoff({
    provider: "chatgpt",
    providerUrl: "https://chatgpt.com/c/old",
    providerConversationId: "old-conversation"
  }, {
    ok: true, handedOff: true, contextWindowFullObserved: true,
    triggerReason: "chatgpt-context-window-full",
    fromUrl: "https://chatgpt.com/c/old",
    toUrl: "https://chatgpt.com/",
    fromConversationId: "old-conversation",
    toConversationId: null,
    url: "https://chatgpt.com/",
    conversationId: null,
    continuationMarker: false,
    verification: "context-window-trigger-and-url-change"
  });
  assert.equal(next.providerConversationId, null);
});

