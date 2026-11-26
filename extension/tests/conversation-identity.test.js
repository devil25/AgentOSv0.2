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

test("preserves one canonical AgentOS task ID across multiple verified context handoffs", () => {
  const original = {
    id: "task-canonical-30",
    provider: "chatgpt",
    tabId: 12,
    providerUrl: "https://chatgpt.com/c/first",
    providerConversationId: "conversation-first",
    stageLedger: {
      "24": { number: 24, total: 30, status: "passed", attemptCount: 1 }
    },
    actionHistory: [{ action: "terminal.execute", result: { ok: true } }]
  };

  const second = applyChatGPTHandoff(original, {
    ok: true,
    handedOff: true,
    contextWindowFullObserved: true,
    triggerReason: "chatgpt-context-window-full",
    fromUrl: "https://chatgpt.com/c/first",
    toUrl: "https://chatgpt.com/c/second",
    fromConversationId: "conversation-first",
    toConversationId: "conversation-second",
    url: "https://chatgpt.com/c/second",
    conversationId: "conversation-second",
    continuationMarker: false,
    verification: "context-window-trigger-and-conversation-id-change"
  }, "2026-11-26T12:00:00.000Z");

  const third = applyChatGPTHandoff(second, {
    ok: true,
    handedOff: true,
    contextWindowFullObserved: true,
    triggerReason: "chatgpt-context-window-full",
    fromUrl: "https://chatgpt.com/c/second",
    toUrl: "https://chatgpt.com/c/third",
    fromConversationId: "conversation-second",
    toConversationId: "conversation-third",
    url: "https://chatgpt.com/c/third",
    conversationId: "conversation-third",
    continuationMarker: false,
    verification: "context-window-trigger-and-conversation-id-change"
  }, "2026-11-26T13:00:00.000Z");

  assert.equal(second.id, original.id);
  assert.equal(third.id, original.id);
  assert.equal(third.providerConversationId, "conversation-third");
  assert.equal(third.handoffEvents.length, 2);
  assert.deepEqual(third.handoffEvents.map(event => event.taskId), [
    "task-canonical-30",
    "task-canonical-30"
  ]);
  assert.deepEqual(third.stageLedger, original.stageLedger);
  assert.deepEqual(third.actionHistory, original.actionHistory);
});

test("does not adopt an arbitrary local-chatgpt URL without a task-bound handoff event", () => {
  const { isVerifiedChatGPTContinuation } = require("../conversation-identity.js");
  const state = {
    id: "task-safe-1", provider: "chatgpt", phase: "awaiting_model",
    providerUrl: "https://chatgpt.com/c/old",
    conversationTransfer: { to: "https://chatgpt.com/c/new" }
  };
  assert.equal(isVerifiedChatGPTContinuation(
    state, "https://chatgpt.com/c/local-chatgpt:unrelated", null, false
  ), false);
});

test("accepts only a continuation bound to the same task and its verified handoff target", () => {
  const { isVerifiedChatGPTContinuation } = require("../conversation-identity.js");
  const state = {
    id: "task-safe-2", provider: "chatgpt", phase: "awaiting_model",
    providerUrl: "https://chatgpt.com/c/new",
    handoffEvents: [{
      provider: "chatgpt", taskId: "task-safe-2",
      triggerReason: "chatgpt-context-window-full",
      toUrl: "https://chatgpt.com/c/new",
      toConversationId: "conversation-new"
    }],
    conversationTransfer: {
      method: "chatgpt-context-window-new-chat",
      triggerReason: "chatgpt-context-window-full",
      to: "https://chatgpt.com/c/new",
      toConversationId: "conversation-new"
    }
  };
  assert.equal(isVerifiedChatGPTContinuation(
    state, "https://chatgpt.com/c/new", null, false
  ), true);
  assert.equal(isVerifiedChatGPTContinuation(
    state, "https://chatgpt.com/c/local-chatgpt:migrated", "conversation-new", false
  ), true);
  assert.equal(isVerifiedChatGPTContinuation(
    state, "https://chatgpt.com/c/local-chatgpt:migrated", null, true
  ), true);
  assert.equal(isVerifiedChatGPTContinuation(
    state, "https://chatgpt.com/c/unrelated-standard-route", null, true
  ), false);
  assert.equal(isVerifiedChatGPTContinuation(
    state, "https://chatgpt.com/c/local-chatgpt:other", "conversation-other", false
  ), false);
  assert.equal(isVerifiedChatGPTContinuation(
    { ...state, id: "different-task" },
    "https://chatgpt.com/c/local-chatgpt:migrated", "conversation-new", false
  ), false);
});

test("requires the handoff ledger and transfer metadata to agree", () => {
  const { isVerifiedChatGPTContinuation } = require("../conversation-identity.js");
  const state = {
    id: "task-safe-3", provider: "chatgpt", phase: "awaiting_model",
    handoffEvents: [{
      provider: "chatgpt", taskId: "task-safe-3",
      triggerReason: "chatgpt-context-window-full",
      toUrl: "https://chatgpt.com/c/new",
      toConversationId: "conversation-new"
    }],
    conversationTransfer: {
      method: "chatgpt-context-window-new-chat",
      triggerReason: "chatgpt-context-window-full",
      to: "https://chatgpt.com/c/new",
      toConversationId: "different-conversation"
    }
  };
  assert.equal(isVerifiedChatGPTContinuation(
    state, "https://chatgpt.com/c/new", null, false
  ), false);
  assert.equal(isVerifiedChatGPTContinuation(
    { ...state, phase: "completed" },
    "https://chatgpt.com/c/new", null, false
  ), false);
});

test("rejects a conflicting DOM identity even when a continuation marker is present", () => {
  const { isVerifiedChatGPTContinuation } = require("../conversation-identity.js");
  const state = {
    id: "task-safe-4", provider: "chatgpt", phase: "awaiting_model",
    handoffEvents: [{
      provider: "chatgpt", taskId: "task-safe-4",
      triggerReason: "chatgpt-context-window-full",
      toUrl: "https://chatgpt.com/c/new",
      toConversationId: "conversation-new"
    }],
    conversationTransfer: {
      method: "chatgpt-context-window-new-chat",
      triggerReason: "chatgpt-context-window-full",
      to: "https://chatgpt.com/c/new",
      toConversationId: "conversation-new"
    }
  };
  assert.equal(isVerifiedChatGPTContinuation(
    state, "https://chatgpt.com/c/local-chatgpt:other", "conversation-other", true
  ), false);
});
