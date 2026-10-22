import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectPushRecovery } from "../server/push-recovery.ts";

const target = {
  repository: "/repo",
  remote: "origin",
  branch: "main",
  commit: "a".repeat(40),
};

function report(targets = [target], state = "푸시") {
  return `푸시대상: ${JSON.stringify(targets)}\n작업상태: ${state}`;
}

function turn(id = "planner", targets = [target]) {
  const text = report(targets);
  return {
    key: `${id}-completed-response`,
    request: "이 변경을 승인한 대상에 푸시해줘",
    auditRevision: `${id}-provider-turn-1:100`,
    text,
    messageIds: [`${id}-request`],
    failed: null,
    evidence: {
      report: text,
      changed: false,
      pushes: targets.map((item, index) => ({
        cwd: item.repository,
        remote: item.remote,
        branch: item.branch,
        commit: item.commit,
        callId: `${id}-successful-push-${index}`,
      })),
    },
  };
}

function review(targets = [target], status = "complete") {
  return `<paseo-workflow>${JSON.stringify({
    status,
    summary: "실행한 변경과 푸시 결과 검토",
    handoff: "대상 커밋의 검증 결과를 확인했습니다.",
    next: status === "plan" || status === "continue" ? "새 변경을 구현하세요." : "",
    pushTargets: targets,
  })}</paseo-workflow>`;
}

function fixture(mode = "general") {
  const members = [{ id: "planner", role: "plan" }];
  if (mode === "federated") members.push({ id: "executor", role: "execute" });
  const input = { cwd: "/repo", mode, repositories: ["/repo"], targets: [target], members };
  const histories = new Map(members.map((member) => [member.id, turn(member.id)]));
  if (mode === "federated") {
    const planner = histories.get("planner");
    planner.text = planner.evidence.report = review();
    planner.evidence.pushes = [];
  }
  const snapshots = new Map(
    members.map(({ id }) => [
      id,
      {
        id,
        status: "idle",
        permission: false,
        archived: false,
      },
    ]),
  );
  const calls = { remote: [], history: [], inspect: [], commit: [], forbidden: [] };
  const forbid = (name) => async () => {
    calls.forbidden.push(name);
    throw Error(`unexpected side effect: ${name}`);
  };
  const port = {
    inspect: async (id) => {
      calls.inspect.push(id);
      return structuredClone(snapshots.get(id));
    },
    pushAuditHistory: async (id) => {
      calls.history.push(id);
      return structuredClone(histories.get(id));
    },
    history: forbid("non-strict-history"),
    historicalPush: forbid("old-history-search"),
    send: forbid("send"),
    create: forbid("create"),
    rename: forbid("rename"),
    compact: forbid("compact"),
    pushReview: { pin: forbid("pin"), unpin: forbid("unpin") },
  };
  const probe = {
    repository: async (cwd) => cwd,
    commit: async (cwd, hash) => {
      calls.commit.push({ cwd, hash });
      return target.commit;
    },
    pushedTarget: async (value) => {
      calls.remote.push(structuredClone(value));
      return true;
    },
    pushTarget: forbid("current-head-target"),
    pushed: forbid("current-head-check"),
    snapshot: forbid("snapshot"),
    changes: forbid("changes"),
  };
  return {
    input,
    port,
    probe,
    histories,
    snapshots,
    calls,
    run: () => inspectPushRecovery(input, port, probe),
  };
}

test("recovery confirms the observed commit without mutating the workflow or running agent actions", async () => {
  const f = fixture();
  const before = structuredClone({ input: f.input, histories: [...f.histories] });
  const result = await f.run();
  assert.equal(result.state, "pushed");
  assert.deepEqual(result.targets, [target]);
  assert.deepEqual(result.check.targets, [{ ...target, result: "pushed" }]);
  assert.equal(result.receipt.agentId, "planner");
  assert.equal(result.receipt.turnKey, "planner-completed-response");
  assert.deepEqual(result.receipt.calls, ["planner-successful-push-0"]);
  assert.deepEqual(f.calls.remote, [target]);
  assert.deepEqual(f.calls.commit, []);
  assert.deepEqual(f.calls.history, ["planner", "planner"]);
  assert.deepEqual(f.calls.inspect, ["planner", "planner"]);
  assert.deepEqual(f.calls.forbidden, []);
  assert.deepEqual({ input: f.input, histories: [...f.histories] }, before);
});

test("an actual successful push can recover when the final status declaration was omitted", async () => {
  const f = fixture();
  const current = f.histories.get("planner");
  current.text = current.evidence.report = "원격 반영과 설치 안내를 마쳤습니다.";
  const result = await f.run();
  assert.equal(result.state, "pushed");
  assert.deepEqual(f.calls.remote, [target]);
});

test("full SHA-256 commits and refs/heads branches remain pinned to the observed target", async () => {
  const f = fixture();
  const full = { ...target, branch: "refs/heads/main", commit: "c".repeat(64) };
  f.input.targets = [full];
  f.histories.set("planner", turn("planner", [full]));
  const result = await f.run();
  assert.equal(result.state, "pushed");
  assert.deepEqual(result.targets, [{ ...full, branch: "main" }]);
  assert.deepEqual(f.calls.remote, [{ ...full, branch: "main" }]);
  assert.deepEqual(f.calls.commit, []);
});

test("remote presence and an assistant's PUSH claim alone never create an execution receipt", async () => {
  for (const claimed of [false, true]) {
    const f = fixture();
    const current = f.histories.get("planner");
    current.evidence.pushes = [];
    if (!claimed) current.text = current.evidence.report = "구현을 완료했습니다.";
    const result = await f.run();
    assert.equal(result.state, claimed ? "unverified" : "none");
    assert.deepEqual(f.calls.remote, []);
    assert.deepEqual(f.calls.forbidden, []);
    assert.equal(result.receipt, undefined);
  }
});

test("targetless recovery accepts an observed current-repository push but not an unrelated repository", async () => {
  for (const foreign of [false, true]) {
    const f = fixture();
    f.input.targets = [];
    f.input.repositories = [];
    const current = f.histories.get("planner");
    current.text = current.evidence.report = "작업상태: 푸시";
    if (foreign) current.evidence.pushes[0].cwd = "/foreign";
    const result = await f.run();
    assert.equal(result.state, foreign ? "unverified" : "pushed");
    assert.deepEqual(f.calls.remote, foreign ? [] : [target]);
    assert.deepEqual(f.calls.forbidden, []);
  }
});

test("current targets, reported targets and every actual push must describe the same commits", async () => {
  for (const mismatch of ["current-commit", "reported-commit", "remote", "branch", "extra-push"]) {
    const f = fixture();
    const current = f.histories.get("planner");
    if (mismatch === "current-commit") f.input.targets = [{ ...target, commit: "b".repeat(40) }];
    if (mismatch === "reported-commit")
      current.text = current.evidence.report = report([{ ...target, commit: "b".repeat(40) }]);
    if (mismatch === "remote") current.evidence.pushes[0].remote = "another";
    if (mismatch === "branch") current.evidence.pushes[0].branch = "another";
    if (mismatch === "extra-push")
      current.evidence.pushes.push({
        ...current.evidence.pushes[0],
        branch: "another",
        callId: "extra",
      });
    assert.equal((await f.run()).state, "unverified", mismatch);
    assert.deepEqual(f.calls.remote, [], mismatch);
  }
});

test("multiple target recovery requires every observed push to resolve and verify", async () => {
  const second = { ...target, repository: "/second", commit: "b".repeat(40) };
  for (const unresolved of [false, true]) {
    const f = fixture();
    f.input.targets = [target, second];
    f.histories.set("planner", turn("planner", [target, second]));
    if (unresolved) f.probe.repository = async (cwd) => (cwd === "/second" ? null : cwd);
    const result = await f.run();
    assert.equal(result.state, unresolved ? "retry" : "pushed");
    assert.deepEqual(f.calls.remote, unresolved ? [] : [target, second]);
    if (!unresolved)
      assert.deepEqual(result.receipt.calls, [
        "planner-successful-push-0",
        "planner-successful-push-1",
      ]);
  }
});

test("a current HEAD or branch name cannot substitute for the commit actually pushed", async () => {
  for (const hash of ["", "HEAD", "main", "origin/main", "HEAD~1"]) {
    const f = fixture();
    f.histories.get("planner").evidence.pushes[0].commit = hash;
    const result = await f.run();
    assert.notEqual(result.state, "pushed", hash);
    assert.deepEqual(f.calls.remote, [], hash);
    assert.deepEqual(f.calls.commit, [], hash);
  }
});

test("an observed abbreviated hash must resolve to its own full commit", async () => {
  for (const resolved of [target.commit, "b".repeat(40), "aaaaaaa", null]) {
    const f = fixture();
    f.histories.get("planner").evidence.pushes[0].commit = "aaaaaaa";
    f.probe.commit = async (cwd, hash) => {
      f.calls.commit.push({ cwd, hash });
      return resolved;
    };
    const result = await f.run();
    assert.equal(result.state, resolved === target.commit ? "pushed" : "retry");
    assert.deepEqual(f.calls.commit, [{ cwd: "/repo", hash: "aaaaaaa" }]);
    assert.deepEqual(f.calls.remote, resolved === target.commit ? [target] : []);
  }
});

test("an execution without its original tool call identity cannot create a receipt", async () => {
  const f = fixture();
  f.histories.get("planner").evidence.pushes[0].callId = "";
  assert.equal((await f.run()).state, "retry");
  assert.deepEqual(f.calls.remote, []);
});

test("duplicate executions for the same branch remain ambiguous", async () => {
  const f = fixture();
  const pushes = f.histories.get("planner").evidence.pushes;
  pushes.push({ ...pushes[0], callId: "second-success" });
  assert.equal((await f.run()).state, "retry");
  assert.deepEqual(f.calls.remote, []);
});

test("new work, pending approval, failed responses and compaction cannot inherit an earlier push", async () => {
  for (const kind of [
    "active",
    "plan",
    "pending",
    "failed",
    "compacted",
    "structured-plan",
    "structured-input",
  ]) {
    const f = fixture();
    const current = f.histories.get("planner");
    if (kind === "active") current.text = current.evidence.report = "작업상태: 진행";
    if (kind === "plan") current.text = current.evidence.report = "작업상태: 계획";
    if (kind === "pending") current.text = current.evidence.report = "푸시할까요?\n작업상태: 완료";
    if (kind === "failed") current.failed = "interrupted";
    if (kind === "compacted") current.compacted = true;
    if (kind === "structured-plan")
      current.text = current.evidence.report = review([target], "plan");
    if (kind === "structured-input")
      current.text = current.evidence.report = review([target], "input");
    assert.equal((await f.run()).state, "none", kind);
    assert.deepEqual(f.calls.remote, [], kind);
  }
});

test("a new phase declared by the user or retained in response text overrides stale push evidence", async () => {
  for (const location of ["request", "text"]) {
    for (const state of ["계획", "진행"]) {
      const f = fixture();
      const current = f.histories.get("planner");
      current[location] = `새 작업을 시작합니다.\n작업상태: ${state}`;
      assert.equal((await f.run()).state, "none", `${location} ${state}`);
      assert.deepEqual(f.calls.remote, []);
    }
  }
});

test("normal implementation before a same-turn successful push is not mistaken for a later task", async () => {
  const f = fixture();
  const current = f.histories.get("planner");
  current.text = `작업상태: 진행\n코드를 수정하고 검증했습니다.\n${current.text}`;
  current.evidence.changed = true;
  assert.equal((await f.run()).state, "pushed");
  assert.deepEqual(f.calls.remote, [target]);
});

test("malformed targets or structured decisions do not guess a successful result", async () => {
  for (const text of [
    "푸시대상: broken\n작업상태: 푸시",
    "<paseo-workflow>broken</paseo-workflow>",
    `${review([target], "plan")}\n${review()}`,
  ]) {
    const f = fixture();
    f.histories.get("planner").text = f.histories.get("planner").evidence.report = text;
    assert.equal((await f.run()).state, "retry");
    assert.deepEqual(f.calls.remote, []);
  }
});

test("a federated executor push requires the latest planner review to confirm those exact targets", async () => {
  const f = fixture("federated");
  const result = await f.run();
  assert.equal(result.state, "pushed");
  assert.equal(result.receipt.agentId, "executor");
  assert.equal(result.receipt.turnKey, "executor-completed-response");
  assert.deepEqual(result.receipt.calls, ["executor-successful-push-0"]);
  assert.deepEqual(f.calls.remote, [target]);
  assert.deepEqual(f.calls.forbidden, []);
});

test("an old executor cannot finish a newer planner task or an unmatched final review", async () => {
  for (const kind of [
    "new-plan",
    "no-review",
    "no-targets",
    "other-target",
    "changed",
    "planner-new-push",
  ]) {
    const f = fixture("federated");
    const planner = f.histories.get("planner");
    if (kind === "new-plan") planner.text = planner.evidence.report = review([target], "plan");
    if (kind === "no-review") planner.text = planner.evidence.report = "새 요청에 관한 설명입니다.";
    if (kind === "no-targets") planner.text = planner.evidence.report = review([]);
    if (kind === "other-target")
      planner.text = planner.evidence.report = review([{ ...target, commit: "b".repeat(40) }]);
    if (kind === "changed") planner.evidence.changed = true;
    if (kind === "planner-new-push")
      planner.evidence.pushes = turn("planner", [
        { ...target, commit: "b".repeat(40) },
      ]).evidence.pushes;
    const result = await f.run();
    assert.notEqual(result.state, "pushed", kind);
    assert.deepEqual(f.calls.remote, [], kind);
  }
});

test("both conversations' actual pushes must match when a planner also pushed", async () => {
  const f = fixture("federated");
  f.histories.get("planner").evidence.pushes = turn().evidence.pushes;
  const result = await f.run();
  assert.equal(result.state, "pushed");
  assert.equal(result.receipt.agentId, "planner");
  assert.deepEqual(f.calls.remote, [target]);
});

test("missing or temporarily unavailable strict history is retried without searching old turns", async () => {
  for (const kind of [
    "missing-port",
    "invalid-metadata",
    "query-failure",
    "inspect-failure",
    "missing-remote-check",
  ]) {
    const f = fixture();
    if (kind === "missing-port") delete f.port.pushAuditHistory;
    if (kind === "invalid-metadata" || kind === "query-failure")
      f.port.pushAuditHistory = async () => {
        throw Error(kind);
      };
    if (kind === "inspect-failure")
      f.port.inspect = async () => {
        throw Error("offline");
      };
    if (kind === "missing-remote-check") delete f.probe.pushedTarget;
    assert.equal((await f.run()).state, "retry", kind);
    assert.deepEqual(f.calls.remote, [], kind);
    assert.deepEqual(f.calls.forbidden, [], kind);
  }
});

test("remote absence, uncertainty and query failure never produce PUSH", async () => {
  for (const value of [false, null, "throw"]) {
    const f = fixture();
    f.probe.pushedTarget = async (actual) => {
      f.calls.remote.push(actual);
      if (value === "throw") throw Error("network unavailable");
      return value;
    };
    const result = await f.run();
    assert.equal(result.state, "retry");
    assert.equal(result.receipt, undefined);
    assert.deepEqual(f.calls.remote, [target]);
  }
});

test("a changed request, report, execution or audit revision during remote lookup cancels recovery", async () => {
  for (const kind of ["request", "report", "execution", "revision"]) {
    const f = fixture();
    f.probe.pushedTarget = async () => {
      const latest = f.histories.get("planner");
      if (kind === "request") latest.request = "이어서 다른 기능을 수정해줘";
      if (kind === "report") latest.text += "\n새 작업을 시작합니다.";
      if (kind === "execution")
        latest.evidence.pushes.push({ ...latest.evidence.pushes[0], callId: "new-call" });
      if (kind === "revision") latest.auditRevision += ":new-entry";
      return true;
    };
    assert.equal((await f.run()).state, "retry", kind);
    assert.deepEqual(f.calls.forbidden, [], kind);
  }
});

test("every member must remain idle and available before and after the remote lookup", async () => {
  for (const when of ["before", "during"]) {
    for (const kind of ["running", "permission", "archived", "missing"]) {
      const f = fixture("federated");
      const change = () => {
        const agent = f.snapshots.get("executor");
        if (kind === "running") agent.status = "running";
        if (kind === "permission") agent.permission = true;
        if (kind === "archived") agent.archived = true;
        if (kind === "missing") f.snapshots.delete("executor");
      };
      if (when === "before") change();
      else
        f.probe.pushedTarget = async () => {
          change();
          return true;
        };
      assert.equal((await f.run()).state, "retry", `${when} ${kind}`);
      assert.deepEqual(f.calls.forbidden, []);
    }
  }
});
