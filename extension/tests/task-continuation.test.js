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
    task: "Run all 25 stages.",
    initialPrompt: "AGENTOS_SYSTEM_RULES_UNIQUE\nUSER TASK: run all 25 stages.",
    steps: 2,
    actionHistory: [first, latest]
  };

  const prompt = buildContinuationPrompt(state, latest);
  assert.match(prompt, /AGENTOS_SYSTEM_RULES_UNIQUE/);
  assert.match(prompt, /exact envelope/);
  assert.match(prompt, /terminal\.execute/);
  assert.match(prompt, /STAGE_01_PASS/);
  assert.match(prompt, /STAGE_02_PASS/);
  assert.match(prompt, /first stage that has not succeeded/);
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

test("bounds non-action recovery attempts", () => {
  const { nextNonActionRetryCount } = require("../task-continuation.js");
  assert.equal(nextNonActionRetryCount({ nonActionRetries: 0 }), 1);
  assert.equal(nextNonActionRetryCount({ nonActionRetries: 1 }), 2);
  assert.equal(nextNonActionRetryCount({ nonActionRetries: 2 }), null);
});
