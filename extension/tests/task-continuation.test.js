const test = require("node:test");
const assert = require("node:assert/strict");
const { buildContinuationPrompt } = require("../task-continuation.js");

test("continuation in a new conversation repeats the complete original AgentOS prompt", () => {
  const first = {
    action: "terminal.execute",
    arguments: { command: "Write-Output STAGE_01_PASS", cwd: "D:\\workspace" },
    result: { ok: true, returncode: 0, stdout: "STAGE_01_PASS" }
  };
  const latest = {
    action: "terminal.execute",
    arguments: { command: "Write-Output STAGE_02_PASS" },
    result: { ok: true, returncode: 0, stdout: "STAGE_02_PASS" }
  };
  const state = {
    id: "task-stable-25",
    task: "Run all 25 stages.",
    initialPrompt: "AGENTOS_SYSTEM_RULES_UNIQUE\nUSER TASK: run all 25 stages.",
    steps: 2,
    stageLedger: { "1": { number: 1, total: 25, status: "passed" } },
    handoffEvents: [{
      taskId: "task-stable-25",
      triggerReason: "chatgpt-context-window-full",
      fromConversationId: "old-chat",
      toConversationId: "new-chat"
    }],
    actionHistory: [first, latest]
  };

  const prompt = buildContinuationPrompt(state, latest);
  assert.match(prompt, /AGENTOS_SYSTEM_RULES_UNIQUE/);
  assert.match(prompt, /exact envelope/);
  assert.match(prompt, /terminal\.execute/);
  assert.match(prompt, /STAGE_01_PASS/);
  assert.match(prompt, /STAGE_02_PASS/);
  assert.match(prompt, /first stage that has not succeeded/);
  assert.match(prompt, /task-stable-25/);
  assert.match(prompt, /PERSISTED STAGE LEDGER/);
  assert.match(prompt, /AUTOMATIC CONTEXT HANDOFF EVENT LEDGER/);
  assert.match(prompt, /old-chat/);
  assert.match(prompt, /new-chat/);
});

test("legacy saved tasks still receive an explicit AgentOS action protocol", () => {
  const prompt = buildContinuationPrompt({ task: "Inspect a project." }, {
    action: "workspace.list",
    arguments: { path: "." },
    result: { ok: true, stdout: "project.godot" }
  });
  assert.match(prompt, /Inspect a project/);
  assert.match(prompt, /agentos\.v1/);
  assert.match(prompt, /Supported actions/);
});

test("action history is bounded to the latest 40 records", () => {
  const history = Array.from({ length: 45 }, (_, i) => ({
    action: "terminal.execute",
    arguments: { command: "Write-Output STEP_" + (i + 1) },
    result: { ok: true, stdout: "STEP_" + (i + 1) + "_PASS" }
  }));
  const prompt = buildContinuationPrompt({
    initialPrompt: "Run the steps.",
    actionHistory: history
  });
  assert.doesNotMatch(prompt, /STEP_1_PASS/);
  assert.match(prompt, /STEP_6_PASS/);
  assert.match(prompt, /STEP_45_PASS/);
});

test("recognizes tasks that explicitly require terminal or workspace actions", () => {
  const { requiresAgentAction } = require("../task-continuation.js");
  assert.equal(requiresAgentAction({ task: "Run 25 stages using terminal.execute." }), true);
  assert.equal(requiresAgentAction({ task: "Run the following 25 stages, one terminal call per stage." }), true);
  assert.equal(requiresAgentAction({ task: "Execute the PowerShell command and report the output." }), true);
  assert.equal(requiresAgentAction({ task: "List files with workspace.list." }), true);
  assert.equal(requiresAgentAction({ task: "Explain what a Godot scene is." }), false);
});

test("builds one bounded action-protocol recovery prompt without claiming execution", () => {
  const { buildNonActionRetryPrompt } = require("../task-continuation.js");
  const state = {
    task: "Run all 25 stages using terminal.execute.",
    initialPrompt: "FULL_AGENTOS_INSTRUCTIONS_AND_TASK",
    actionHistory: [],
    steps: 0
  };
  const prompt = buildNonActionRetryPrompt(state, "I will start by checking the project.");
  assert.match(prompt, /FULL_AGENTOS_INSTRUCTIONS_AND_TASK/);
  assert.match(prompt, /That response executed no action/);
  assert.match(prompt, /exactly ONE valid fenced JSON action envelope/);
  assert.match(prompt, /I will start by checking the project/);
});


test("keeps a numbered multi-stage task incomplete until its final stage succeeds", () => {
  const { requiresUnfinishedStagedTask } = require("../task-continuation.js");
  const state = {
    task: "Run the following 25 stages, one terminal call per stage.",
    steps: 9,
    actionHistory: [{
      action: "terminal.execute",
      arguments: { command: "Write-Output 'HANDOFF_STAGE=09/25'; Write-Output 'STAGE_09_PASS'" },
      result: { ok: true, stdout: "HANDOFF_STAGE=09/25\nSTAGE_09_PASS" }
    }]
  };
  assert.equal(requiresUnfinishedStagedTask(state), true);
  state.actionHistory.push({
    action: "terminal.execute",
    arguments: { command: "Write-Output 'HANDOFF_STAGE=25/25'; Write-Output 'STAGE_25_PASS'" },
    result: { ok: true, stdout: "HANDOFF_STAGE=25/25\nSTAGE_25_PASS" }
  });
  assert.equal(requiresUnfinishedStagedTask(state), false);
});

test("stage ledger keeps a failed attempt retryable, then blocks a repeated successful stage", () => {
  const {
    beginStageAttempt, recordStageResult, isStageAlreadyPassed, getStageDescriptor
  } = require("../task-continuation.js");
  const action = {
    action: "terminal.execute",
    arguments: { command: "Write-Output 'HANDOFF_STAGE=24/25'; Write-Output 'STAGE_24_PASS'" }
  };
  assert.deepEqual(getStageDescriptor(action), { number: 24, total: 25, key: "24" });

  let state = { stageLedger: {} };
  state.stageLedger = beginStageAttempt(state, action, "2026-11-26T10:00:00.000Z");
  state.stageLedger = recordStageResult(state, {
    ...action, result: { ok: false, returncode: 1, stdout: "", stderr: "first attempt failed" }
  }, "2026-11-26T10:00:01.000Z");
  assert.equal(state.stageLedger["24"].status, "failed");
  assert.equal(state.stageLedger["24"].attemptCount, 1);
  assert.equal(isStageAlreadyPassed(state, action), false);

  state.stageLedger = beginStageAttempt(state, action, "2026-11-26T10:00:02.000Z");
  state.stageLedger = recordStageResult(state, {
    ...action, result: {
      ok: true, returncode: 0,
      stdout: "HANDOFF_STAGE=24/25\nSTAGE_24_PASS", stderr: ""
    }
  }, "2026-11-26T10:00:03.000Z");
  assert.equal(state.stageLedger["24"].status, "passed");
  assert.equal(state.stageLedger["24"].attemptCount, 2);
  assert.equal(isStageAlreadyPassed(state, action), true);
});

test("stage ledger does not pass a command without its current execution pass marker", () => {
  const { beginStageAttempt, recordStageResult } = require("../task-continuation.js");
  const action = {
    action: "terminal.execute",
    arguments: { command: "Write-Output 'HANDOFF_STAGE=7/25'" }
  };
  let state = { stageLedger: {} };
  state.stageLedger = beginStageAttempt(state, action);
  state.stageLedger = recordStageResult(state, {
    ...action, result: { ok: true, returncode: 0, stdout: "An old log says STAGE_07_PASS", stderr: "" }
  });
  assert.equal(state.stageLedger["7"].status, "failed");
  assert.equal(state.stageLedger["7"].resultEvidence, "missing-stage-pass-marker");
});

test("stage numbers from a different stage plan cannot satisfy or block this task", () => {
  const { isStageAlreadyPassed, requiresUnfinishedStagedTask } = require("../task-continuation.js");
  const state = {
    task: "Run all 25 stages.",
    stageLedger: { "25": { number: 25, total: 30, status: "passed" } }
  };
  const action = {
    action: "terminal.execute",
    arguments: { command: "Write-Output 'HANDOFF_STAGE=25/25'; Write-Output 'STAGE_25_PASS'" }
  };
  assert.equal(isStageAlreadyPassed(state, action), false);
  assert.equal(requiresUnfinishedStagedTask(state), true);
});

test("ambiguous and non-stage terminal commands are not blocked by the stage ledger", () => {
  const { isStageAlreadyPassed, getStageDescriptor } = require("../task-continuation.js");
  assert.equal(getStageDescriptor({
    action: "terminal.execute", arguments: { command: "Get-ChildItem" }
  }), null);
  assert.equal(isStageAlreadyPassed({
    stageLedger: { "24": { status: "passed" } }
  }, {
    action: "terminal.execute", arguments: { command: "Get-ChildItem" }
  }), false);
});

test("a failed final-stage ledger entry overrides legacy-looking pass text", () => {
  const { requiresUnfinishedStagedTask } = require("../task-continuation.js");
  const state = {
    task: "Run all 25 stages.",
    stageLedger: { "25": { number: 25, total: 25, status: "failed" } },
    actionHistory: [{
      action: "terminal.execute",
      arguments: { command: "Write-Output 'HANDOFF_STAGE=25/25'; Write-Output 'STAGE_25_PASS'" },
      result: { ok: true, returncode: 0, stdout: "STAGE_25_PASS" }
    }]
  };
  assert.equal(requiresUnfinishedStagedTask(state), true);
});

test("bounds non-action recovery attempts", () => {
  const { nextNonActionRetryCount } = require("../task-continuation.js");
  assert.equal(nextNonActionRetryCount({ nonActionRetries: 0 }), 1);
  assert.equal(nextNonActionRetryCount({ nonActionRetries: 1 }), 2);
  assert.equal(nextNonActionRetryCount({ nonActionRetries: 2 }), null);
});

test("recovers only an exhausted AgentOS non-action protocol error", () => {
  const {
    isRecoverableNonActionProtocolError,
    canRecoverFromNonActionProtocolError,
    recoverNonActionProtocolState
  } = require("../task-continuation.js");
  const state = {
    id: "task-stable-30",
    phase: "error",
    nonActionRetries: 2,
    error: "The AI website returned ordinary text instead of the next required AgentOS action. The staged task is still incomplete; no completion was recorded. Resume after inspecting the conversation.",
    response: "I will continue with the next step.",
    protocolRecovery: {
      response: "I will continue with the next step.",
      messageIds: ["assistant-old"]
    },
    actionHistory: [{ action: "terminal.execute", result: { ok: true } }],
    stageLedger: { "21": { number: 21, total: 30, status: "passed" } },
    handoffEvents: [{ taskId: "task-stable-30", triggerReason: "chatgpt-context-window-full" }]
  };
  assert.equal(isRecoverableNonActionProtocolError(state), true);
  assert.equal(canRecoverFromNonActionProtocolError(state, "I will continue with the next step.", ["assistant-old"]), false);
  const actionText = JSON.stringify({ protocol: "agentos.v1", type: "action", action: "terminal.execute", arguments: { command: "Write-Output PASS" } });
  assert.equal(canRecoverFromNonActionProtocolError(state, actionText, ["assistant-new"]), true);
  const recovered = recoverNonActionProtocolState(state, actionText, ["assistant-new"]);
  assert.equal(recovered.phase, "awaiting_model");
  assert.equal(recovered.error, null);
  assert.equal(recovered.id, state.id);
  assert.deepEqual(recovered.actionHistory, state.actionHistory);
  assert.deepEqual(recovered.stageLedger, state.stageLedger);
  assert.deepEqual(recovered.handoffEvents, state.handoffEvents);
  assert.equal(recovered.nonActionRetries, 2);
  assert.equal(isRecoverableNonActionProtocolError({ ...state, error: "Native host disconnected" }), false);
  assert.equal(isRecoverableNonActionProtocolError({ ...state, nonActionRetries: 1 }), false);
});

test("legacy protocol errors require a different response body before recovery", () => {
  const { canRecoverFromNonActionProtocolError } = require("../task-continuation.js");
  const legacy = {
    phase: "error",
    nonActionRetries: 2,
    error: "The AI website returned ordinary text instead of a valid AgentOS action after the bounded protocol-recovery attempts. No action was executed. Inspect the AI response before retrying.",
    response: "I will inspect the result."
  };
  assert.equal(canRecoverFromNonActionProtocolError(legacy, "I will inspect the result.", ["message-1"]), false);
  assert.equal(canRecoverFromNonActionProtocolError(legacy, JSON.stringify({ protocol: "agentos.v1" }), ["message-2"]), true);
});
