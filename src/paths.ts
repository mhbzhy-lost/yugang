/**
 * 仓库根与各目录的**唯一解析点**（2026-11-05）。
 *
 * 背景：代码按文件位置推路径，文件一搬家就会静默漂（runtime 从 src/ 挪进 src/app/ 后，
 * 数据目录从 `仓库/var` 漂成 `src/var`，线上跑了两小时空库，而 scripts/ 自算路径还在读旧库，
 * 把问题整个盖住）。所以这里只有一份实现，src/ 与 scripts/ 都从这里取，谁也不许再自己拼。
 *
 * 解析顺序：
 * - `YUGANG_ROOT`：仓库根（推荐在 .env 里显式写死；不写则按本文件位置推导 —— src/paths.ts 的上一级）
 * - `YUGANG_HOME`：只覆盖数据目录（历史开关，保留）；不写 = `<仓库根>/var`
 * - 其余（media / workspace / prompt / 配置文件）都从上面两个派生，单项目录仍可用同名环境变量覆盖
 *
 * 常量在进程启动时求值：改环境变量要重启进程（与 .env 的语义一致）。
 */
import { join, resolve } from "node:path";

/** 仓库根：`YUGANG_ROOT` 优先，否则按本文件位置（src/paths.ts）推。 */
export const REPO_ROOT = resolve(process.env.YUGANG_ROOT ?? join(import.meta.dirname, ".."));

/** 数据目录（fish.db / chatlog / media / usage / sent.json 都在这里）。 */
export const DATA_HOME = resolve(process.env.YUGANG_HOME ?? join(REPO_ROOT, "var"));

/** 媒体根（inbound / gen / personas / memes / meme-inbox）。 */
export const MEDIA_ROOT = resolve(process.env.MEDIA_ROOT ?? join(DATA_HOME, "media"));

/** 每个（群 × 人格）一个工作目录。 */
export const WORKSPACE_ROOT = resolve(process.env.WORKSPACE_ROOT ?? join(DATA_HOME, "workspace"));

/** prompt 目录（人格书、共享文案、工具说明的源）。 */
export const PROMPT_ROOT = resolve(process.env.PROMPT_ROOT ?? join(REPO_ROOT, "prompt"));

/** 行为配置（热加载）。 */
export const FISH_CONFIG_PATH = join(REPO_ROOT, "fish.config.json");

/** 模型与凭据配置。 */
export const MODELS_CONFIG_PATH = join(REPO_ROOT, "config", "models.json");
