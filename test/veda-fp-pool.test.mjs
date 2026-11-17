/**
 * Veda 指纹池红线测试：acquire() 绝不自动铸新指纹。
 * 背景：X-Fp 是上游额度分组键，多指纹 = 多「设备」并行刷额度，属规避访问控制。
 * 修复前 acquire() 在全池用尽时无条件铸新池（无视 size 上限）——这里锁死该行为。
 */
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { VedaFpPool } from "../server/src/providers/veda-fp-pool.mjs";

async function tmpPool(opts) {
  const file = path.join(os.tmpdir(), `veda-fp-pool-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  return { pool: new VedaFpPool({ persistFile: file, ...opts }), file };
}

const cleanup = async (file) => fs.rm(file, { force: true });

test("size=1：额度耗尽（remaining=0）时拒绝并抛 quota_exhausted，不铸新池", async () => {
  const { pool, file } = await tmpPool({ size: 1 });
  try {
    const slot = await pool.acquire();
    assert.equal(slot.id, 0);
    // 服务端回写：20 点用尽
    await pool.report(0, { used: 20, limit: 20, remaining: 0 });
    await assert.rejects(
      () => pool.acquire(),
      (e) => e.code === "quota_exhausted" && /额度已用尽/.test(e.message),
    );
    const pools = await pool.load();
    assert.equal(pools.length, 1, "绝不自动扩池");
  } finally {
    await cleanup(file);
  }
});

test("size=1：在途占满（remaining 未耗尽）时抛 too_many_pending，不铸新池", async () => {
  const { pool, file } = await tmpPool({ size: 1, perPool: 1 });
  try {
    await pool.acquire(); // issued=1，占满 perPool
    await assert.rejects(
      () => pool.acquire(),
      (e) => e.code === "too_many_pending",
    );
    const pools = await pool.load();
    assert.equal(pools.length, 1);
  } finally {
    await cleanup(file);
  }
});

test("size=1：额度恢复（remaining>0 回写）后同一池继续可用", async () => {
  const { pool, file } = await tmpPool({ size: 1 });
  try {
    const s1 = await pool.acquire();
    await pool.report(0, { used: 20, limit: 20, remaining: 0 });
    await assert.rejects(() => pool.acquire(), { code: "quota_exhausted" });
    // 任务终态 → release 占位（对应 vedaSyncJob 的终态释放）
    await pool.release(0);
    // 24h 窗口恢复：服务端报剩余额度
    await pool.report(0, { used: 0, limit: 20, remaining: 20 });
    const s2 = await pool.acquire();
    assert.equal(s2.id, 0, "恢复后复用原池，不扩新池");
  } finally {
    await cleanup(file);
  }
});

test("size=2：池数上限内可建第二个池，但绝不越出 size", async () => {
  const { pool, file } = await tmpPool({ size: 2, perPool: 1 });
  try {
    const a = await pool.acquire(); // 池 0
    await pool.report(a.id, { remaining: 0 }); // 池 0 额度用尽
    const b = await pool.acquire(); // 允许建池 1（显式配置范围内）
    assert.equal(b.id, 1);
    await pool.report(b.id, { remaining: 0 });
    await assert.rejects(() => pool.acquire(), { code: "quota_exhausted" });
    const pools = await pool.load();
    assert.equal(pools.length, 2, "达到 size 上限后绝不越界");
  } finally {
    await cleanup(file);
  }
});

test("首次使用（空池）可正常建立池 0", async () => {
  const { pool, file } = await tmpPool({ size: 1 });
  try {
    const s = await pool.acquire();
    assert.equal(s.id, 0);
    assert.match(s.fp, /^[0-9a-f]{64}$/, "指纹是 64 位 hex");
  } finally {
    await cleanup(file);
  }
});

test("release 幂等：多次释放不会把 issued 减成负数", async () => {
  const { pool, file } = await tmpPool({ size: 1 });
  try {
    await pool.acquire();
    await pool.release(0);
    await pool.release(0);
    await pool.release(0);
    const pools = await pool.load();
    assert.equal(pools[0].issued, 0);
    // 释放后立即可再次 acquire
    const s = await pool.acquire();
    assert.equal(s.id, 0);
  } finally {
    await cleanup(file);
  }
});
