/**
 * PabaTV 账号池自适应轮询选择测试。
 * 核心断言：连续提交时账号会轮转，不会总挑同一个（修复前 lastSubmitAt 没持久化导致恒选第一个）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { rankAccounts } from "../server/src/queue.mjs";

/** 模拟一轮提交：选中的账号 consumed+1、last=now，然后再选 */
function simulateRoundRobin(ids, rounds) {
  let clock = 1_000;
  const state = Object.fromEntries(ids.map((id) => [id, { id, active: 0, consumed: 0, last: 0 }]));
  const picks = [];
  for (let i = 0; i < rounds; i++) {
    const ranked = rankAccounts(Object.values(state));
    const chosen = ranked[0].id;
    picks.push(chosen);
    // 提交成功后的效果：消耗 +1、最近提交时间刷新
    state[chosen].consumed += 1;
    state[chosen].last = ++clock;
  }
  return picks;
}

test("两个账号连续 6 次提交应严格交替，不锁死单个", () => {
  const picks = simulateRoundRobin(["A", "B"], 6);
  assert.deepEqual(picks, ["A", "B", "A", "B", "A", "B"]);
});

test("三个账号连续 9 次提交应各占 1/3", () => {
  const picks = simulateRoundRobin(["A", "B", "C"], 9);
  const counts = picks.reduce((m, id) => ((m[id] = (m[id] || 0) + 1), m), {});
  assert.equal(counts.A, 3);
  assert.equal(counts.B, 3);
  assert.equal(counts.C, 3);
});

test("在途多的账号即使消耗少也让位给空闲账号", () => {
  const ranked = rankAccounts([
    { id: "busy", active: 2, consumed: 0, last: 0 },
    { id: "idle", active: 0, consumed: 3, last: 999 },
  ]);
  assert.equal(ranked[0].id, "idle");
});

test("在途和消耗都相同时，最久未提交的账号优先（last 小的在前）", () => {
  const ranked = rankAccounts([
    { id: "recent", active: 0, consumed: 2, last: 200 },
    { id: "oldest", active: 0, consumed: 2, last: 50 },
  ]);
  assert.equal(ranked[0].id, "oldest");
});

test("rankAccounts 不修改原数组", () => {
  const input = [
    { id: "b", active: 0, consumed: 1, last: 2 },
    { id: "a", active: 0, consumed: 0, last: 1 },
  ];
  const snapshot = JSON.stringify(input);
  rankAccounts(input);
  assert.equal(JSON.stringify(input), snapshot);
});
