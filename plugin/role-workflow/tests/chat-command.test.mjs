import { test } from "node:test";
import assert from "node:assert/strict";
import { chatControl, chatFederate } from "../shared/chat-command.ts";

const workflow = {
  id: "workflow-1",
  status: "paused",
  planAgentId: "plan-agent",
  executeAgentId: "execute-agent",
};

for (const agentId of ["plan-agent", "execute-agent"]) {
  test(`resume matches ${agentId}`, () => {
    assert.deepEqual(chatControl([workflow], agentId, "resume", ""), {
      id: workflow.id,
      action: "resume",
      message: "",
    });
  });
}

test("rejects an unconnected conversation", () => {
  assert.throws(() => chatControl([workflow], "other-agent", "resume", ""), {
    message: "이 대화는 자동 작업에 연결되어 있지 않습니다.",
  });
});

test("rejects resume while active", () => {
  assert.throws(
    () => chatControl([{ ...workflow, status: "active" }], "plan-agent", "resume", ""),
    { message: "이미 진행 중인 작업입니다." },
  );
});

for (const status of ["paused", "needs_input", "error"]) {
  test(`resume from ${status} trims instructions`, () => {
    assert.deepEqual(
      chatControl([{ ...workflow, status }], "plan-agent", "resume", "  답변\n추가 지시  \n"),
      { id: workflow.id, action: "resume", message: "답변\n추가 지시" },
    );
  });
}

test("pause sends an empty message", () => {
  assert.deepEqual(
    chatControl([{ ...workflow, status: "active" }], "execute-agent", "pause", "ignored"),
    { id: workflow.id, action: "pause", message: "" },
  );
});

for (const status of ["paused", "needs_input", "error", "completed"]) {
  test(`rejects pause while ${status}`, () => {
    assert.throws(() => chatControl([{ ...workflow, status }], "plan-agent", "pause", ""), {
      message: "진행 중인 작업이 아닙니다.",
    });
  });
}

test("prefers an unfinished workflow sharing the same conversation", () => {
  const completed = { ...workflow, id: "old-workflow", status: "completed" };
  for (const workflows of [
    [completed, workflow],
    [workflow, completed],
  ]) {
    assert.equal(chatControl(workflows, "plan-agent", "resume", "").id, workflow.id);
    assert.deepEqual(workflows.map((entry) => entry.id).sort(), ["old-workflow", "workflow-1"]);
  }
});

test("leaves completed resume refusal to the server", () => {
  assert.deepEqual(
    chatControl([{ ...workflow, status: "completed" }], "plan-agent", "resume", ""),
    { id: workflow.id, action: "resume", message: "" },
  );
});

const general = { ...workflow, mode: "general" };

test("federate rejects an unconnected conversation", () => {
  assert.throws(() => chatFederate([general], "other", "idle", ""), {
    message: "이 대화는 자동 작업에 연결되어 있지 않습니다.",
  });
});

test("federate rejects conversion from an execution conversation", () => {
  assert.throws(() => chatFederate([general], "execute-agent", "idle", ""), {
    message: "실행 대화에서는 전환할 수 없습니다. 계획 대화에서 입력하세요.",
  });
});

for (const status of ["paused", "needs_input", "error"]) {
  for (const agentId of ["plan-agent", "execute-agent"]) {
    test(`federate resumes ${status} federation from ${agentId}`, () => {
      assert.deepEqual(
        chatFederate([{ ...general, mode: "federated", status }], agentId, "idle", "  계속  "),
        { kind: "control", input: { id: workflow.id, action: "resume", message: "계속" } },
      );
    });
  }
}

test("federate rejects an active federation", () => {
  assert.throws(
    () =>
      chatFederate([{ ...general, mode: "federated", status: "active" }], "plan-agent", "idle", ""),
    { message: "이미 진행 중인 작업입니다." },
  );
});

for (const mode of ["general", "undecided"]) {
  for (const agentStatus of ["idle", "error", "closed"]) {
    test(`federate sends an explicit conversion request for ${mode}/${agentStatus}`, () => {
      const action = chatFederate([{ ...general, mode }], "plan-agent", agentStatus, "  ");
      assert.equal(action.kind, "message");
      assert.match(action.text, /연합개발/);
      assert.doesNotMatch(action.text, /일반개발|^작업 ID:|추가 지시:/);
    });
  }
  for (const agentStatus of ["running", "initializing"]) {
    test(`federate rejects conversion during ${mode}/${agentStatus}`, () => {
      assert.throws(() => chatFederate([{ ...general, mode }], "plan-agent", agentStatus, ""), {
        message: "응답 중입니다. 응답이 끝난 뒤 다시 입력하세요.",
      });
    });
  }
}

test("federate appends trimmed instructions preserving internal newlines", () => {
  const action = chatFederate([general], "plan-agent", "idle", "  첫 지시\n다음 지시  ");
  assert.equal(action.kind, "message");
  assert.ok(action.text.endsWith("\n\n추가 지시:\n첫 지시\n다음 지시"));
});

test("federate prefers an unfinished workflow without reordering input", () => {
  const completed = { ...general, id: "old", mode: "federated", status: "completed" };
  const workflows = [completed, general];
  assert.equal(chatFederate(workflows, "plan-agent", "idle", "").kind, "message");
  assert.deepEqual(workflows, [completed, general]);
  assert.equal(chatFederate([general, completed], "plan-agent", "idle", "").kind, "message");
});
