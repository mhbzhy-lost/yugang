/**
 * ModelScope 异步生图：建任务 → 轮询 → 下载落盘，返回 gen/ 下的相对引用。
 *
 * 只被 draw 的兜底路径调用（本地 SD 画不出来时才走这里），所以这里不做
 * 「每轮限一次」之类的策略，那属于工具层。
 *
 * 轮询必须带 X-ModelScope-Task-Type: image_generation —— 少了它服务端回
 * {"errors":{"code":500,"message":"task not found"},"task_status":"FAILED"}，
 * 看上去像生成失败，其实是请求头不全。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const API_BASE = "https://api-inference.modelscope.cn/v1";
const DEFAULT_MODEL = "Qwen/Qwen-Image";

export interface ModelScopeOptions {
  key: string;
  prompt: string;
  mediaRoot: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** 出图成功返回相对 mediaRoot 的引用（gen/xxx.png）；失败抛错。 */
export async function generateWithModelScope(options: ModelScopeOptions): Promise<string> {
  const model = options.model ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const doFetch = options.fetchImpl ?? fetch;
  const outDir = join(options.mediaRoot, "gen");
  const auth = `Bearer ${options.key}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const submit = await doFetch(`${API_BASE}/images/generations`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        authorization: auth,
        "X-ModelScope-Async-Mode": "true",
        "Model-Id": model,
      },
      body: JSON.stringify({ model, prompt: options.prompt }),
    });
    if (!submit.ok) throw new Error(`submit HTTP ${submit.status}`);
    const task = (await submit.json()) as { task_id?: string };
    const taskId = task.task_id;
    if (!taskId) throw new Error("no task_id");

    const deadline = Date.now() + timeoutMs;
    let urls: string[] = [];
    for (;;) {
      if (Date.now() > deadline) throw new Error("timeout");
      await new Promise((r) => setTimeout(r, 3000));
      const poll = await doFetch(`${API_BASE}/tasks/${taskId}`, {
        signal: ctrl.signal,
        headers: { authorization: auth, "X-ModelScope-Task-Type": "image_generation" },
      });
      if (!poll.ok) throw new Error(`poll HTTP ${poll.status}`);
      const j = (await poll.json()) as {
        task_status?: string;
        output_images?: string[];
        errors?: { message?: string };
      };
      if (j.task_status === "SUCCEED" || j.task_status === "TASK_STATUS_SUCCEED") {
        urls = j.output_images ?? [];
        break;
      }
      if (j.task_status === "FAILED" || j.task_status === "TASK_STATUS_FAILED") {
        throw new Error(`task failed${j.errors?.message ? `: ${j.errors.message}` : ""}`);
      }
    }
    const url = urls[0];
    if (!url) throw new Error("no image");

    const img = await doFetch(url, { signal: ctrl.signal });
    if (!img.ok) throw new Error(`download HTTP ${img.status}`);
    mkdirSync(outDir, { recursive: true });
    const file = `${Date.now()}-${randomUUID().slice(0, 8)}.png`;
    writeFileSync(join(outDir, file), new Uint8Array(await img.arrayBuffer()));
    return `gen/${file}`;
  } finally {
    clearTimeout(timer);
  }
}
