/**
 * 长期记忆的公共入口（barrel，2026-11-05）。
 *
 * 实现按关注点拆到 `src/memory/`：
 *   - model   数据模型、上限、eval entry、空状态与共享文本工具
 *   - patch   applyPatch、上限淘汰、feedback meta
 *   - pending 待审类型、装配、摘要、同意/拒绝
 *   - publicize 公共批准的 AI 脱敏
 *   - query   hasFact / deleteFactById / parseMemoryCommand
 *   - merge   公共层 + 私有层合并
 *   - render  system section 渲染
 *
 * 所有外部 importer 继续从 `./memory/index.ts` 取，导入面不变。安全边界（只审不直写、
 * 渲染零写入、applyPatch 深拷贝、上限机械执行）仍以 model.ts 顶部注释为准。
 */
export * from "./model.ts";
export * from "./patch.ts";
export * from "./pending.ts";
export * from "./publicize.ts";
export * from "./query.ts";
export * from "./merge.ts";
export * from "./render.ts";
