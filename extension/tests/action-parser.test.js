const test = require("node:test");
const assert = require("node:assert/strict");
const { extractAction } = require("../action-parser.js");

const action = {
  protocol: "agentos.v1",
  type: "action",
  action: "workspace.create_file",
  arguments: {
    path: "test-agentos.txt",
    content: "AgentOS is working correctly."
  }
};

test("extracts an action after a text prefix and before trailing prose", () => {
  const response =
    "text" + JSON.stringify(action) +
    "هذا الإجراء سينشئ الملف المطلوب ولن يُنفّذ دون موافقتك.";
  assert.deepEqual(extractAction(response), action);
});

test("extracts a fenced JSON action", () => {
  const fence = String.fromCharCode(96).repeat(3);
  const response = "Use this action:\n" + fence + "json\n" +
    JSON.stringify(action, null, 2) + "\n" + fence;
  assert.deepEqual(extractAction(response), action);
});

test("handles braces inside string values", () => {
  const withBraces = {
    ...action,
    arguments: { path: "sample.txt", content: "literal { brace } text" }
  };
  assert.deepEqual(extractAction("prefix " + JSON.stringify(withBraces)), withBraces);
});

test("rejects unsupported actions", () => {
  const unsupported = { ...action, action: "terminal.execute" };
  assert.equal(extractAction(JSON.stringify(unsupported)), null);
});

test("rejects extra envelope properties", () => {
  const extra = { ...action, execute_immediately: true };
  assert.equal(extractAction(JSON.stringify(extra)), null);
});

test("rejects malformed or incomplete objects", () => {
  assert.equal(extractAction('text{"protocol":"agentos.v1","type":"action"}'), null);
  assert.equal(extractAction('text{"protocol":"agentos.v1","type":"action"'), null);
});
