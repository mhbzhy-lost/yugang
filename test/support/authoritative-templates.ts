/**
 * 权威模板只读解析（decisions §10 机械测试合同的唯一权威输入）。
 *
 * 唯一事实源是 `docs/decisions/2026-11-04-model-input-templates.md`：本 helper 直接读那个
 * 文件里的 `<!-- input-scene-matrix -->` 与 `<!-- input-template:<id> -->` 标记后紧跟的
 * **一个** fenced code block，测试内不另抄任何期望模板，生产代码也不读这份文档。
 *
 * 严格性（decisions §10）：缺标记、重复标记、非法 JSON、矩阵缺场景、残留 `<...>` 占位符
 * 一律直接抛错；只移除围栏与围栏前一个换行，**不** trim、不做空白/标点归一化——
 * 模板正文的每个换行与空行都是被比较对象的一部分。
 *
 * 路径解析：缺省按仓库相对路径（helper 在 `test/support/` 下，仓库根 = 上两级）；
 * worktree 自验时可用环境变量 `YUGANG_DECISIONS_PATH` 指向主仓库的 decisions 绝对路径。
 * 不把任何本机绝对路径写死成缺省值。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** decisions 相对仓库根的位置（缺省路径；可被 YUGANG_DECISIONS_PATH 覆盖）。 */
const DECISIONS_RELATIVE = "docs/decisions/2026-11-04-model-input-templates.md";

/** 矩阵必须覆盖的 scene 数量（decisions §10：16 个 scene，一个都不能少）。 */
export const AUTHORITATIVE_SCENE_COUNT = 16;

export interface AuthoritativeScene {
  scene: string;
  /** 文本段模板 id，按矩阵顺序；多段以一个空行连接后比较完整 input。 */
  templates: readonly string[];
  /** 图片 block 模板 id（JSON 围栏），按编号顺序附在唯一 text block 之后。 */
  blocks: readonly string[];
}

/** 权威文档路径：环境变量优先，其次仓库相对缺省。 */
export function authoritativeDecisionsPath(): string {
  const override = process.env.YUGANG_DECISIONS_PATH;
  if (override !== undefined && override.trim().length > 0) return override;
  return fileURLToPath(new URL(`../../${DECISIONS_RELATIVE}`, import.meta.url));
}

/** 读权威文档原文（不做任何归一化）。 */
export function readAuthoritativeSource(path: string = authoritativeDecisionsPath()): string {
  return readFileSync(path, "utf8");
}

/** 占位符残留检查：`<...>` 形式的未替换占位一律失败。 */
function assertNoPlaceholder(id: string, body: string): void {
  const match = /<[^<>\n]*>/.exec(body);
  if (match) {
    throw new Error(`[权威模板] ${id} 残留占位符 ${match[0]}（decisions §10：占位残留直接失败）`);
  }
}

/**
 * 取标记后紧跟的那个 fenced code block 的正文。
 *
 * 只移除：标记行本身、开围栏行（含 info string）、闭围栏行，以及闭围栏前的那一个换行。
 * 正文原样返回——不 trim、不折叠空白、不改标点。
 */
function fencedBlockAfter(source: string, marker: string, path: string): string {
  const first = source.indexOf(marker);
  if (first < 0) {
    throw new Error(`[权威模板] ${path} 缺标记 ${marker}`);
  }
  if (source.indexOf(marker, first + marker.length) >= 0) {
    throw new Error(`[权威模板] ${path} 标记重复 ${marker}（标记必须唯一）`);
  }

  // 标记必须独占一行（行尾只允许空白），否则它不是在标记一个块
  const markerEnd = first + marker.length;
  const lineEnd = source.indexOf("\n", markerEnd);
  if (lineEnd < 0) throw new Error(`[权威模板] ${path} 标记 ${marker} 后没有换行`);
  if (source.slice(markerEnd, lineEnd).trim().length > 0) {
    throw new Error(`[权威模板] ${path} 标记 ${marker} 同一行还有其它内容`);
  }

  // 开围栏：标记行的下一行必须是 ``` 开头（可带 info string）
  const openMatch = /^```([^\n`]*)\n/.exec(source.slice(lineEnd + 1));
  if (!openMatch) {
    throw new Error(`[权威模板] ${path} 标记 ${marker} 后紧跟的不是 fenced code block`);
  }
  const contentStart = lineEnd + 1 + openMatch[0].length;

  // 闭围栏：正文之后第一个只含 ``` 的行
  const rest = source.slice(contentStart);
  const closeMatch = /^```[ \t]*$/m.exec(rest);
  if (!closeMatch || closeMatch.index === undefined) {
    throw new Error(`[权威模板] ${path} 标记 ${marker} 的 fenced block 没有闭合围栏`);
  }
  // 去掉闭围栏前的那一个换行（开围栏行尾的换行属于围栏，不属于正文）
  const contentEnd = closeMatch.index > 0 ? closeMatch.index - 1 : 0;
  const body = rest.slice(0, contentEnd);
  assertNoPlaceholder(marker, body);
  return body;
}

const MATRIX_MARKER = "<!-- input-scene-matrix -->";

/** 解析并严格校验场景矩阵：16 个 scene、scene 唯一、模板 id 全部存在、JSON 合法。 */
export function loadAuthoritativeScenes(path: string = authoritativeDecisionsPath()): AuthoritativeScene[] {
  const source = readAuthoritativeSource(path);
  const raw = fencedBlockAfter(source, MATRIX_MARKER, path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`[权威模板] ${MATRIX_MARKER} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`[权威模板] ${MATRIX_MARKER} 顶层必须是数组`);

  const scenes: AuthoritativeScene[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of parsed.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`[权威模板] 矩阵第 ${index} 项不是对象`);
    }
    const record = entry as Record<string, unknown>;
    const scene = record.scene;
    if (typeof scene !== "string" || scene.length === 0) {
      throw new Error(`[权威模板] 矩阵第 ${index} 项缺 scene 字符串`);
    }
    if (seen.has(scene)) throw new Error(`[权威模板] 矩阵 scene 重复：${scene}`);
    seen.add(scene);

    const templates = record.templates;
    if (!Array.isArray(templates) || templates.length === 0 || templates.some((t) => typeof t !== "string")) {
      throw new Error(`[权威模板] scene ${scene} 的 templates 必须是非空字符串数组`);
    }
    const blocks = record.blocks;
    if (blocks !== undefined && (!Array.isArray(blocks) || blocks.some((b) => typeof b !== "string"))) {
      throw new Error(`[权威模板] scene ${scene} 的 blocks 必须是字符串数组`);
    }
    for (const id of [...(templates as string[]), ...((blocks as string[] | undefined) ?? [])]) {
      // 模板 id 必须在文档里真的存在（缺标记会由 fencedBlockAfter 抛错）
      fencedBlockAfter(source, `<!-- input-template:${id} -->`, path);
    }
    scenes.push({
      scene,
      templates: [...(templates as string[])],
      blocks: [...((blocks as string[] | undefined) ?? [])],
    });
  }

  if (scenes.length !== AUTHORITATIVE_SCENE_COUNT) {
    throw new Error(
      `[权威模板] 矩阵覆盖 ${scenes.length} 个 scene，应为 ${AUTHORITATIVE_SCENE_COUNT} 个（decisions §10）`,
    );
  }
  return scenes;
}

/** 取一个 `input-template:<id>` 的原文正文（不 trim、不归一化）。 */
export function loadAuthoritativeTemplate(id: string, path: string = authoritativeDecisionsPath()): string {
  const source = readAuthoritativeSource(path);
  return fencedBlockAfter(source, `<!-- input-template:${id} -->`, path);
}

/**
 * 取一个图片 block 模板并严格解析成 JSON（decisions §5.4：type / data / mimeType）。
 * 解析失败直接抛错——图片场景的 base64 与 MIME 必须逐字来自权威文档。
 */
export function loadAuthoritativeBlockJson(id: string, path: string = authoritativeDecisionsPath()): unknown {
  const body = loadAuthoritativeTemplate(id, path);
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`[权威模板] input-template:${id} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 一个 scene 的权威期望文本：多段模板按矩阵顺序以**一个空行**连接（decisions §10）。
 * 段内正文原样保留，不做 trim 或空白归一化。
 */
export function authoritativeSceneText(scene: AuthoritativeScene, path: string = authoritativeDecisionsPath()): string {
  return scene.templates.map((id) => loadAuthoritativeTemplate(id, path)).join("\n\n");
}
