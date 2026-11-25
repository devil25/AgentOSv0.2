const test = require("node:test");
const assert = require("node:assert/strict");
const { CHATGPT_ASSISTANT_SELECTORS } = require("../provider-adapters.js");

test("recognizes current ChatGPT app-shell assistant ownership markers", () => {
  for (const selector of [
    '[data-chatgpt-search-unit-key$=":assistant"]',
    '[data-content-search-unit-key$=":assistant"]',
    '[data-markdown-text-style="assistant-message"]',
    '[data-conversation-role="assistant"]',
    '[data-turn-key]:has([data-conversation-role="assistant"], [data-chatgpt-agent-turn-start])',
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
  assert.ok(!CHATGPT_ASSISTANT_SELECTORS.some(selector =>
    selector === '[class*="markdown" i]' || selector === '[class*="prose" i]'
  ));
});
