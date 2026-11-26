const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CHATGPT_ASSISTANT_SELECTORS,
  CHATGPT_RESPONSE_BODY_SELECTOR,
  CHATGPT_MESSAGE_OWNER_SELECTOR,
  CHATGPT_MESSAGE_SOURCE_SELECTOR,
  CHATGPT_CONVERSATION_ID_SELECTOR,
  resolveChatGPTMessageId,
  resolveChatGPTConversationId
} = require("../provider-adapters.js");

test("recognizes current ChatGPT app-shell assistant ownership markers", () => {
  for (const selector of [
    '[data-chatgpt-search-unit-key$=":assistant"]',
    '[data-content-search-unit-key$=":assistant"]',
    '[data-markdown-text-style="assistant-message"]',
    '[data-conversation-role="assistant"]',
    'section[data-turn="assistant"]',
    '[data-test-id^="conversation-turn-"][data-turn="assistant"]'
  ]) {
    assert.ok(
      CHATGPT_ASSISTANT_SELECTORS.includes(selector),
      `Missing ChatGPT assistant selector: ${selector}`
    );
  }
});

test("retains legacy ChatGPT assistant role selectors", () => {
  assert.ok(CHATGPT_ASSISTANT_SELECTORS.includes('[data-message-author-role="assistant"]'));
  assert.ok(CHATGPT_ASSISTANT_SELECTORS.includes('[data-role="assistant"]'));
  assert.ok(CHATGPT_ASSISTANT_SELECTORS.includes('[data-testid^="conversation-turn-"][data-turn="assistant"]'));
});

test("does not treat generic Markdown or prose classes as assistant ownership", () => {
  assert.ok(!CHATGPT_ASSISTANT_SELECTORS.includes(".markdown"));
  assert.ok(!CHATGPT_ASSISTANT_SELECTORS.includes(".prose"));
  assert.ok(!CHATGPT_ASSISTANT_SELECTORS.includes('[data-turn-key]:has([data-conversation-role="assistant"], [data-chatgpt-agent-turn-start])'));
  assert.ok(!CHATGPT_ASSISTANT_SELECTORS.some(selector =>
    selector === '[class*="markdown" i]' || selector === '[class*="prose" i]'
  ));
});


test("recognizes the current ChatGPT response-body ownership structure", () => {
  assert.equal(CHATGPT_RESPONSE_BODY_SELECTOR, "[data-response-body]");
  assert.equal(CHATGPT_MESSAGE_OWNER_SELECTOR, "[data-chatgpt-selection-message-id]");
  assert.equal(CHATGPT_MESSAGE_SOURCE_SELECTOR, "[data-dil-source-message-id]");
});

test("accepts a ChatGPT message only when its boundary, owner and source IDs agree", () => {
  const id = "83fa5080-c4b9-4c86-8f5c-338ed91f99dc";
  assert.equal(resolveChatGPTMessageId(id, id, id), id);
  assert.equal(resolveChatGPTMessageId(id, id, ""), id);
  assert.equal(resolveChatGPTMessageId(id, "different-message", id), null);
  assert.equal(resolveChatGPTMessageId("", "", ""), null);
});


test("uses a unique ChatGPT DOM conversation identity across URL changes", () => {
  assert.equal(CHATGPT_CONVERSATION_ID_SELECTOR, "[data-chatgpt-selection-conversation-id]");
  assert.equal(resolveChatGPTConversationId(["local-chatgpt:abc", "local-chatgpt:abc"]), "local-chatgpt:abc");
  assert.equal(resolveChatGPTConversationId(["local-chatgpt:abc", "local-chatgpt:other"]), null);
  assert.equal(resolveChatGPTConversationId([]), null);
});

test("recognizes specific active-generation controls without false-positive Stop buttons", () => {
  const { isGenerationControlLabel } = require("../provider-adapters.js");
  assert.equal(isGenerationControlLabel("Stop generating"), true);
  assert.equal(isGenerationControlLabel("Stop response"), true);
  assert.equal(isGenerationControlLabel("Cancel response"), true);
  assert.equal(isGenerationControlLabel("إيقاف التوليد"), true);
  assert.equal(isGenerationControlLabel("Stop"), false);
  assert.equal(isGenerationControlLabel("Stop sharing"), false);
  assert.equal(isGenerationControlLabel("Submit"), false);
});


test("accepts ChatGPT context continuation marker even when the conversation identity is unchanged", () => {
  const { isChatGPTContinuationReady } = require("../provider-adapters.js");
  assert.equal(isChatGPTContinuationReady("conversation-old", "conversation-old", true), true);
  assert.equal(isChatGPTContinuationReady("conversation-old", null, true), true);
  assert.equal(isChatGPTContinuationReady("conversation-old", "conversation-new", false), true);
  assert.equal(isChatGPTContinuationReady("conversation-old", "conversation-old", false), false);
  assert.equal(isChatGPTContinuationReady("conversation-old", null, false), false);
  assert.equal(isChatGPTContinuationReady(null, "conversation-new", false), true);
  assert.equal(isChatGPTContinuationReady(null, null, false), false);
});


test("detects a newly rendered ChatGPT user turn after Send", () => {
  const { hasNewUserMessage } = require("../provider-adapters.js");
  const submitted = "AGENTOS TASK CONTINUATION — SAME TASK, POSSIBLY NEW CONVERSATION";
  assert.equal(hasNewUserMessage(
    ["Earlier message", submitted + " Follow the original task."],
    ["Earlier message"],
    submitted
  ), true);
});

test("does not treat a pre-existing matching user message as a new submission", () => {
  const { hasNewUserMessage } = require("../provider-adapters.js");
  const submitted = "AGENTOS TASK CONTINUATION — SAME TASK";
  assert.equal(hasNewUserMessage(
    [submitted + " Keep going."],
    [submitted + " Keep going."],
    submitted
  ), false);
});

test("recognizes ChatGPT stop-button test identifiers without matching unrelated Stop controls", () => {
  const { isGenerationControlLabel } = require("../provider-adapters.js");
  assert.equal(isGenerationControlLabel("stop-button"), true);
  assert.equal(isGenerationControlLabel("stop_generating_button"), true);
  assert.equal(isGenerationControlLabel("Stop sharing"), false);
});

