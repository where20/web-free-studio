import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizePrompt,
  normalizeDuration,
  normalizeResolution,
  buildSubmitRequest,
  findRun,
  toTaskRow,
  isTerminal,
} from "../server/src/providers/dreamina.mjs";
import { DREAMINA } from "../server/src/config.mjs";

test("prompt 规范化：空/超长拒绝，正常保留", () => {
  assert.throws(() => normalizePrompt("  "), /prompt/);
  assert.throws(() => normalizePrompt("a".repeat(3001)), /3000/);
  assert.equal(normalizePrompt("  你好  "), "你好");
});

test("时长规范化：4-20 秒，默认 10", () => {
  assert.equal(normalizeDuration(undefined), 10);
  assert.equal(normalizeDuration(15), 15);
  assert.throws(() => normalizeDuration(2), /4-20/);
  assert.throws(() => normalizeDuration(30), /4-20/);
});

test("清晰度规范化：seedance 2.5 只支持 720P，任何输入一律归一 720P", () => {
  assert.equal(normalizeResolution("768p"), "720P"); // Paba 的 768p 不能透传给即梦
  assert.equal(normalizeResolution("768P"), "720P");
  assert.equal(normalizeResolution("1080P"), "720P"); // 1080P 也不支持
  assert.equal(normalizeResolution(""), "720P");
  assert.equal(normalizeResolution(undefined), "720P");
  assert.equal(normalizeResolution("720p"), "720P");
  assert.equal(normalizeResolution("4k"), "720P");
});

test("buildSubmitRequest：768P 输入被归一化为 720P（不写进 prompt）", () => {
  const req = buildSubmitRequest({ prompt: "测试", duration: 5, resolution: "768p" });
  assert.equal(req.resolution, "720P");
  assert.match(req.body.message.content[0].data, /720P/);
  assert.doesNotMatch(req.body.message.content[0].data, /768P/);
});

test("buildSubmitRequest：生成完整 submit_run 请求（对标抓包结构）", () => {
  const req = buildSubmitRequest(
    { prompt: "唐装少女歌舞", duration: 15, aspect: "16:9", resolution: "720P" },
    { projectId: "1502254033156", threadId: "thread-x", workspaceId: "ws-1", consumerUid: "7711" },
  );
  assert.match(req.url, /agent\/submit_run\?babi_param=/);
  const u = new URL(req.url);
  const babi = JSON.parse(u.searchParams.get("babi_param"));
  assert.equal(babi.tool_id, "novel_agent");
  assert.equal(babi.section_id, req.runId);

  const body = req.body;
  assert.equal(body.agent_name, DREAMINA.agentName);
  assert.equal(body.project_id, 1502254033156);
  assert.equal(body.user_info.consumer_uid, "7711");
  assert.equal(body.user_info.workspace_id, "ws-1");
  assert.equal(body.message.thread_id, "thread-x");
  assert.equal(body.message.run_id, req.runId);
  assert.equal(body.message.role, "user");
  assert.match(body.message.content[0].data, /seedance2\.5,生成15秒视频，16:9，720P。唐装少女歌舞/);
  assert.equal(body.message.content[0].sub_type, "plain/text");
  assert.equal(body.request_id, body.message.message_id);

  const extra = JSON.parse(body.run_extra);
  assert.equal(extra.novel_script_model_key, "GPT-6.1-Sol");
  assert.equal(extra.babi_param.generate_id, req.runId);
  const settings = extra.novel_ui_context.items.find((i) => i.type === "project-settings");
  assert.equal(settings.data.ratio, "16:9");
  assert.equal(settings.data.videoModel.key, "Seedance_2.5");
});

test("buildSubmitRequest：无固定 session 时用配置默认，user_info 不带空 uid", () => {
  const req = buildSubmitRequest({ prompt: "test" });
  assert.equal(req.body.project_id, Number(DREAMINA.projectId));
  assert.equal(req.body.message.thread_id, DREAMINA.threadId);
  assert.ok(!("consumer_uid" in req.body.user_info));
  assert.equal(req.body.user_info.workspace_id, DREAMINA.workspaceId);
});

test("findRun：从 thread 解析状态与 video artifact_id", () => {
  const thread = {
    run_list: [
      {
        run_id: "run-1",
        state: 3,
        completed_at: 1795580730,
        created_at: 1795580300,
        fail_reason: null,
        entry_list: [
          {
            message: {
              role: "assistant",
              content: [
                {
                  sub_type: "biz/x_artifact_slots_part",
                  data: JSON.stringify({ slots: [{ artifact_id: "1502254048004", type: "video" }] }),
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const snap = findRun(thread, "run-1");
  assert.equal(snap.status, "done");
  assert.equal(snap.state, 3);
  assert.equal(snap.artifactId, "1502254048004");
  assert.equal(snap.completedAt, 1795580730000);
});

test("findRun：state=2 视为 running，无 artifact", () => {
  const thread = { run_list: [{ run_id: "r2", state: 2, entry_list: [] }] };
  const snap = findRun(thread, "r2");
  assert.equal(snap.status, "running");
  assert.equal(snap.artifactId, null);
});

test("findRun：state=9 识别为 needs_input 并带 agent 反问", () => {
  const thread = {
    run_list: [
      {
        run_id: "r9", state: 9, completed_at: 1795582130, fail_reason: null,
        entry_list: [
          { message: { role: "assistant", content: [{ type: "text", data: "台词太长了，建议延长到 20 秒？" }] } },
        ],
      },
    ],
  };
  const snap = findRun(thread, "r9");
  assert.equal(snap.status, "needs_input");
  assert.equal(snap.state, 9);
  assert.match(snap.question, /延长到 20 秒/);
  assert.equal(snap.artifactId, null);
});

test("toTaskRow / isTerminal：统一状态映射", () => {
  const row = toTaskRow({ status: "done", state: 3, artifactId: "a1", createdAt: 1000 });
  assert.equal(row.status, "done");
  assert.equal(row.stage, "已完成");
  assert.equal(row.artifactId, "a1");
  assert.equal(isTerminal("done"), true);
  assert.equal(isTerminal("failed"), true);
  assert.equal(isTerminal("needs_input"), true);
  assert.equal(isTerminal("running"), false);
  assert.equal(isTerminal("queued"), false);
});
