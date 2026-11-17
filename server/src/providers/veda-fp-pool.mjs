/**
 * Veda 指纹池管理器。
 *
 * 2026-11-17 实测破解（linzhi-ai-studio 同源结论，4 次独立 A/B 实验交叉验证）：
 * 服务端把 `X-Fp` 头（浏览器指纹 SHA-256）当作设备身份的分组键：
 *   · 不带 X-Fp        → 落「无指纹默认池」
 *   · 带 X-Fp=<任意值> → 该值对应一个独立 20 credits/天池，初始 used=0 / window=null
 *   · 提交后才绑定 24h 窗口（首次 GET quota 返回 window_start:null 是未绑定态）
 *   · 池间互不影响；已排除 veda_did / X-Device-Id / XFF / 出口 IP（均无效）
 *
 * 红线（2026-11-17 用户确认）：
 *   · 指纹是客户端可控的分组键，多指纹 = 多「设备」并行刷额度 —— 不做
 *   · 池数量硬上限 size（默认 1 = 官方单设备行为），扩池只能显式设 VEDA_FP_POOL_SIZE
 *   · acquire() 绝不自动铸新指纹：全部池额度耗尽时如实报 quota_exhausted，等 24h 窗口恢复
 *   · 状态里如实标注池来源与用量，不做隐瞒
 *
 * 真实瓶颈不是额度，是 GPU 槽位：上游 2×RTX 4090，slots_total=2。
 * 同一时刻全局只能有 2 条在生成，满槽换池也没用。
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** 生成一个稳定的 64 位 hex 指纹（模拟浏览器 SHA-256 指纹的形状） */
export function makeFingerprint() {
  return crypto
    .createHash("sha256")
    .update(`veda-fp:${crypto.randomBytes(16).toString("hex")}`)
    .digest("hex");
}

export class VedaFpPool {
  /**
   * @param {object} opts
   * @param {number} opts.size       池数量（= 并行「设备」数），默认 1
   * @param {number} opts.perPool    每个指纹发多少条后换新指纹，默认 1（最稳）
   * @param {string} opts.persistFile 持久化文件（重启不丢账）
   */
  constructor({ size = 1, perPool = 1, persistFile = null } = {}) {
    this.size = Math.max(1, Number(size) || 1);
    this.perPool = Math.max(1, Number(perPool) || 1);
    this.persistFile = persistFile;
    this.pools = null; // [{ id, fp, used, issued, limit, remaining, resetsAt }]
    this.cursor = 0;
    this.loading = null;
  }

  async load() {
    if (this.pools) return this.pools;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      let saved = null;
      if (this.persistFile) {
        try {
          saved = JSON.parse(await fs.readFile(this.persistFile, "utf8"));
        } catch {
          saved = null; // 首次运行无文件，正常
        }
      }
      // 优先完整状态（used/issued/remaining 都保留，重启不丢账）
      if (saved && Array.isArray(saved.pools) && saved.pools.length) {
        this.pools = saved.pools
          .filter((p) => p && typeof p.fp === "string" && p.fp.length >= 16)
          .map((p, i) => ({
            id: Number.isFinite(p.id) ? p.id : i,
            fp: p.fp,
            used: Number(p.used || 0),
            issued: Number(p.issued || 0),
            limit: Number(p.limit || 0),
            remaining: p.remaining == null ? null : Number(p.remaining),
            resetsAt: p.resetsAt || null,
          }));
      } else {
        const list = Array.isArray(saved?.fingerprints) && saved.fingerprints.length
          ? saved.fingerprints
          : null;
        this.pools = (list || Array.from({ length: this.size }, () => makeFingerprint())).map(
          (fp, i) => ({ id: i, fp, used: 0, issued: 0, limit: 0, remaining: null, resetsAt: null }),
        );
      }
      // 池数不足补齐（扩容后重启的场景）
      while (this.pools.length < this.size) {
        this.pools.push({
          id: this.pools.length,
          fp: makeFingerprint(),
          used: 0,
          issued: 0,
          limit: 0,
          remaining: null,
          resetsAt: null,
        });
      }
      await this.save();
      return this.pools;
    })();
    return this.loading;
  }

  async save() {
    if (!this.persistFile || !this.pools) return;
    try {
      if (this.persistFile.includes("/")) await fs.mkdir(path.dirname(this.persistFile), { recursive: true });
      await fs.writeFile(
        this.persistFile,
        JSON.stringify(
          {
            pools: this.pools.map((p) => ({ ...p })),
            fingerprints: this.pools.map((p) => p.fp), // 旧字段，向后兼容
            size: this.size,
            perPool: this.perPool,
            updatedAt: Date.now(),
          },
          null,
          1,
        ),
        { mode: 0o600 },
      );
    } catch {
      // 落盘失败不影响本次调用
    }
  }

  /**
   * 取一个可用池（issued < perPool 且服务端没报 0 余额）。
   *
   * 红线（2026-11-17 与用户确认）：**绝不自动铸造新指纹**。
   * 多指纹 = 多「设备」并行刷额度，属规避上游访问控制 —— 与 Paba 的
   * 「不做 XFF/指纹轮换刷额度」同一边界。池数量硬上限 = size（默认 1，
   * 与官方单设备行为一致）；扩池只能显式设 VEDA_FP_POOL_SIZE，代码不自动越界。
   * 额度耗尽 → 如实报 quota_exhausted 等 24h 窗口恢复；吞吐瓶颈本来就是 GPU 槽位。
   */
  async acquire(perPool = this.perPool) {
    const pools = await this.load();
    const limit = Math.max(1, Number(perPool) || 1);
    for (let i = 0; i < pools.length; i++) {
      const idx = (this.cursor + i) % pools.length;
      const p = pools[idx];
      if ((p.issued || 0) < limit && p.remaining !== 0) {
        this.cursor = (idx + 1) % pools.length;
        p.issued = (p.issued || 0) + 1;
        await this.save();
        return { id: p.id, fp: p.fp };
      }
    }
    if (pools.length >= this.size) {
      // remaining 严格 ===0 才判「额度耗尽」（null/undefined = 未知，保守按在途满处理）
      const exhausted = pools.length > 0 && pools.every((p) => p.remaining === 0);
      const err = new Error(
        exhausted
          ? `Veda 额度已用尽（指纹池 ${pools.length}/${this.size} 全部 remaining=0）。等 24h 窗口恢复；扩池（多指纹=多设备并行）属刷额度行为，不做。`
          : `Veda 指纹池在途已满（每池并发上限 ${limit}）。等出片再提交。`,
      );
      err.code = exhausted ? "quota_exhausted" : "too_many_pending";
      throw err;
    }
    const p = {
      id: pools.length,
      fp: makeFingerprint(),
      used: 0,
      issued: 1,
      limit: 0,
      remaining: null,
      resetsAt: null,
    };
    pools.push(p);
    this.cursor = 0;
    await this.save();
    return { id: p.id, fp: p.fp };
  }

  /** 服务端 quota 回写（保持本地视图与上游一致） */
  async report(id, quota) {
    const pools = await this.load();
    const p = pools.find((x) => x.id === id);
    if (!p) return;
    if (quota && typeof quota === "object") {
      p.used = Number(quota.used ?? p.used);
      p.limit = Number(quota.limit ?? p.limit);
      p.remaining = quota.remaining != null ? Number(quota.remaining) : p.remaining;
      p.resetsAt = quota.resets_at ?? quota.resetsAt ?? p.resetsAt;
      await this.save();
    }
  }

  /** 首选池完整指纹（无任务上下文的请求用） */
  async currentFingerprint() {
    const pools = await this.load();
    return pools[0]?.fp || null;
  }

  /** 任务终态后释放该池的并发占位（幂等；issued 只减不增，减到 0 为止） */
  async release(id) {
    const pools = await this.load();
    const p = pools.find((x) => x.id === id);
    if (!p) return;
    if ((p.issued || 0) > 0) {
      p.issued -= 1;
      await this.save();
    }
  }

  /** 状态快照（供 UI 展示；fp 只给前 12 位，完整指纹不外泄） */
  async snapshot() {
    const pools = await this.load();
    return pools.map((p) => ({
      id: p.id,
      fp: p.fp.slice(0, 12) + "…",
      used: p.used,
      issued: p.issued || 0,
      limit: p.limit,
      remaining: p.remaining,
      resetsAt: p.resetsAt,
    }));
  }
}
