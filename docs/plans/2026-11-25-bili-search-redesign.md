# `bili_search` 工具重做（基于 DeepSeek Search 的 B 站视频检索）实施计划

> **For agentic workers:** Implement this plan task-by-task in order. Work each step as written (test-first steps: write the test, watch it fail, implement minimally, watch it pass), check off each `- [ ]` step as it completes, and commit where the plan says commit. Do not start a task before the previous task's tests pass.

**Goal:** 将原有基于 B 站固定分区排行榜的 `bili_hot` 工具重做并更名为 `bili_search`，改为经 DeepSeek Search API 检索并仅过滤 Bilibili 视频（`bilibili.com/video/BV...`），支持自由关键词、默认 60 天时效窗与不足自动放宽，保留同群 `fish.video_pool` 去重与文本硬筛，且不消耗 B 站 API 每日配额。

**Architecture:** 先将 `src/tools/search/tool.ts` 中的 DeepSeek Search HTTP 客户端、响应封顶校验、日期解析、取消信号传播与文本/内嵌 URL 清洗抽出为共享模块 `src/external/deepseek-search.ts`（Task 1），再在 `src/external/video-links.ts` 增补严格的 B 站视频路径 BV 提取器 `biliVideoBvidOfUrl`（Task 2）；随后在一个原子绿色提交中完成 `src/tools/bili_search/` 四件套、移除 `src/tools/bili_hot/`、切换 `loader.ts` 注册并全仓同步提示词、测试与文档（Task 3）。

**Tech Stack:** TypeScript (Node.js ESM, `node --test`), `@earendil-works/pi-durable`, DeepSeek Search API (`https://api.deepseek.com/v1/tools/search`).

**Spec:** 本对话已确认的产品决策与实测事实：
1. 工具更名为 `bili_search`（替换 `bili_hot`），全仓同步 `prompt/`、`test/`、`AGENTS.md`、`README.md` 及工具间引用。
2. 模型传自由 `query`（1–80 UTF-16 字符）+ 可选 `days`（0–365 整数，缺省 `60`，`0` 为不限时间）；自动拼接 `site:bilibili.com/video` 与 `after:YYYY-MM-DD`（已在实机 DeepSeek Search 实测验证 `site:bilibili.com/video`、`after:YYYY-MM-DD` 及响应 `date`/`rerank_score` 字段可用）；`days > 0` 时若客户端校验并过滤后可用结果 `< 3` 条，在总超时预算内自动去掉 `after:` 放宽重搜一次并合并去重（时间窗结果优先）。
3. 不调用 B 站 API 补齐播放/点赞元数据（零 B 站每日预算消耗）；只保留同群 `fish.video_pool` 去重（`shared` 永久 + `seen` 7 天）与文本硬筛（`titleBait / uc / listicle / promoDesc`）。`bili-client` 的 `view` / `dm` / `reply` / `card` / `spi` 全部保留服务 `video` 与 `bili_video`。

## Global Constraints

- **Git 命令**：优先使用 `git1`，仅在不可用时回退 `git`；commit message 格式 `type(scope): 中文祈使句`（≤50 字、无句号、禁止 AI 署名），禁止使用 `git add -A`，始终显式指定文件路径。
- **工具四件套契约（AGENTS §2）**：`src/tools/bili_search/` 必须包含 `TOOL.md`（frontmatter `name` + `description` + 指南）、严格 JSON `schema.json`（不写无运行时效果的 `default` 字段）、`messages.json`、`tool.ts`；`src/tools/loader.ts` 中 `FACTORIES` 与 manifest 必须双向一一对应，每个提交都必须保持 `npm test` 与 `npm run prompts` 全绿。
- **无死文案（`test/prompts.test.ts:155-159`）**：`src/tools/bili_search/messages.json` 中每个 key 必须被 `src/tools/bili_search/tool.ts` 以 `messages["<key>"]` 字面量形式引用，且不得与 `prompt/messages.md` 或其它 active 工具 key 冲突；工具内模型可见文案必须走 `TOOL.md` / `messages.json`。
- **延迟加载与无凭据注册**：`bili_search` 保持 `deferred: true`（由 `loader.ts` 统一加，factory 本体不写）；与 `search` 一致，缺少 `deps.searchKey` 时**仍然注册**（保证无 key 的测试如 `test/tools.test.ts` 与 `test/prompts.test.ts` 通过），仅在 `execute` 时抛 `bili_search_nokey`。
- **外层超时与取消信号安全**：默认工具外层超时为 30s（`src/fish/tool-surface.ts:117-121`）。`deepseekSearch` 必须支持 `signal?: AbortSignal` 并与单次超时合成；`bili_search` 整次执行（含首次 + 自动放宽）共享总预算 `24_000ms`（首次上限 `14_000ms`，放宽仅在剩余预算 `≥ 4_000ms` 时触发），并透传 `context?.abortSignal`；写入 `VideoPoolDoc` 前必须检查取消信号，取消/超时路径不得占用轮内额度或写入 `seen`。
- **链接白名单边界（AGENTS §4 / §17）**：`bili_search` 输出行只包含 `BV` 号，**不得输出任何 `http(s)://` 链接**（标题与简介必须抹除内嵌 URL），防止 `withSeenLinkHarvest` 在模型未调 `video` 观看前把链接提前写入白名单。
- **B 站客户端保留**：`src/external/bili-client.ts`（含 `createBiliFiltersLoader` / `DEFAULT_BILI_FILTERS` / `getBiliClient`）继续服务 `video`、`bili_video` 与 `bili_search` 文本硬筛，不得删除或破坏。
- **验证入口**：最终必须通过 `npm test` 与 `npm run prompts`。

## Review Focus

1. **同一视频多锚点重复返回**：DeepSeek Search 实测会对同一 `BV` 返回带 `#2`/`#4`/`#5` 或 `?spm_id_from=...` 的多条记录；必须先抽取规范 `BV` 再去重，保留排序最靠前的一条（合并时间窗与放宽结果时同样优先保留时间窗内的记录）。
2. **非视频链接与 `av` 号 / 伪造域名绕过**：结果中可能混入 `/video/av...`、`/opus/...`、`/read/...`、`?ref=BV...` 或 `bilibili.com.evil.example/video/BV...`；`biliVideoBvidOfUrl` 必须用 `URL` 解析主机名（`=== "bilibili.com"` 或 `.endsWith(".bilibili.com")`）并严格匹配 `pathname` 为 `/^\/video\/(BV[0-9A-Za-z]{10})(?:\/|$)/`。
3. **模型手写算子、UTF-16 长度与时效兜底**：模型可能在 `query` 中手写 `site:zhihu.com`、`-site:x`、`after:2020-01-01崩坏3`、`before:2025-01-01` 或含 emoji 的超长文本；`normalizeBiliSearchQuery` 必须用 `[+-]?(?:site|after|before):[A-Za-z0-9._:/-]+` 精准剥离算子且不吞后续中文词，用 UTF-16 `.length` 限制在 `1..80`（确保 `24 + 80 + 17 = 121 <= 128`）；当 `days > 0` 且处于首次非放宽轮时，客户端还需按已解析的 `publishedAtMs` 机械剔除早于 `nowMs - (days + 1) * 86_400_000` 的过期条目（无日期条目保留）。
4. **放宽重搜超时/失败降级与轮内额度安全**：串行两次检索必须在 24s 总预算内完成且响应 `context.abortSignal`；放宽重搜失败而首次已有 1–2 条有效结果时保留首次结果并如实不标“已放宽”；最终 0 条或完全失败时不扣减本轮搜索次数（单轮上限 2 次，允许换词重试一次）且不写 `fish.video_pool`；网络异常/`AbortError` 原样上抛，仅 `SearchResponseError` 转 `bili_search_failed`。
5. **标题/摘要噪音与无 URL 泄露**：B 站 `summary` 常附带侧边栏推荐列表，`title` 常带 `_哔哩哔哩_bilibili - 00:41` 后缀；必须优先取 `snippet`（空时回退 `summary` 首段，避开侧栏噪音导致 `uc`/`promoDesc` 误杀），剥离站名后缀（剥完为空时回退原清洗标题或 `"无标题"`），抹掉内嵌 URL 并把字段内 `|` 替换为 `｜`。

---

### Task 1: 抽离 DeepSeek Search 共享客户端并保持 `search` 行为等价

**Depends on:** `none`

**Files:**
- Create: `src/external/deepseek-search.ts`
- Modify: `src/tools/search/tool.ts:1-170`
- Create: `test/deepseek-search.test.ts`

**Interfaces:**
- Produces in `src/external/deepseek-search.ts`:
  - `export const DEEPSEEK_SEARCH_ENDPOINT = "https://api.deepseek.com/v1/tools/search"`
  - `export const SEARCH_RESPONSE_MAX_BYTES = 1 * 1024 * 1024`
  - `export const SEARCH_RESULTS_MAX = 100`
  - `export class SearchResponseError extends Error {}`
  - `export interface DeepSeekSearchItem { url: string; rawTitle: string; rawSummary: string; rawSnippet: string; date?: string; publishedAtMs?: number; rerankScore?: number; }`
  - `export interface DeepSeekSearchOptions { apiKey: string; query: string; count: number; timeoutMs?: number; endpoint?: string; signal?: AbortSignal; fetch?: typeof fetch; }`
  - `export function cleanSearchText(value: unknown, maxLen: number): string`
  - `export async function deepseekSearch(options: DeepSeekSearchOptions): Promise<DeepSeekSearchItem[]>`
- Modifies in `src/tools/search/tool.ts`:
  - `export interface SearchToolOptions { fetch?: typeof fetch; }`
  - `export function createSearchTool(manifest: ToolManifest, deps: ToolPackageDeps, options?: SearchToolOptions): ToolRegistration`（第 3 参可选，兼容 `ToolPackageFactory` 签名；保持原有 `slice(0, count)` 先于 URL 过滤、`cleanSearchText(rawTitle, 80)`、`summary || snippet` 优先序、一轮一次 `SEARCHED` 锁、`count = 4` 与 `context.abortSignal` 透传）。

- [ ] **Step 1: Write failing tests in `test/deepseek-search.test.ts`**

包含以下测试（全部注入 mock `fetch`，不发真实外网请求）：
1. `"deepseekSearch 解析 url/rawTitle/rawSummary/rawSnippet/date/publishedAtMs/rerankScore 并保留 slice(0, count) 后滤非法 URL"`：
   - 验证合法 `date`（如 `"2026-11-18T16:00:00+00:00"`）解析出 `publishedAtMs`，`date: null` / `"invalid"` 为 `undefined`，有限数 `rerank_score` 映射为 `rerankScore`；
   - 验证在 `count=2` 时前 2 条含 1 条非法 URL 会只返回 1 条（不越界补第 3 条，保持与旧 `search/tool.ts:98` 一致）。
2. `"cleanSearchText 清洗控制字符、抹除内嵌 URL 并按上限截断"`。
3. `"deepseekSearch 响应非 2xx / 非 JSON / 非法结构 / 超结果上限 / 超 1MiB 抛 SearchResponseError"`。
4. `"deepseekSearch 网络错误、超时与外部 AbortSignal 取消均原样上抛，不包装成 SearchResponseError"`。
5. `"createSearchTool 行为回归：渲染 1. title\\nurl\\nbrief（summary 优先于 snippet）、成功锁同轮抛 search_used、空结果释放可重试、SearchResponseError 翻为 search_failed"`。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/deepseek-search.test.ts`
Expected: FAIL（`src/external/deepseek-search.ts` 尚不存在）

- [ ] **Step 3: Implement `src/external/deepseek-search.ts` and refactor `src/tools/search/tool.ts`**

- 在 `src/external/deepseek-search.ts` 实现 `deepseekSearch`、`cleanSearchText`、`SearchResponseError` 与 `readResponseBodyCapped`：
  - 使用 `AbortController` 定时中止 + 监听 `options.signal`（若已 aborted 直接拒绝；否则联动 abort 并在 `finally` 移除监听与 `clearTimeout`）。
  - 严格保留 `rawResults.slice(0, count)` 后逐项校验 `sanitizeUrl` 的顺序；返回 `rawTitle` / `rawSummary` / `rawSnippet` 让调用方按各自规则截断与选优，同时导出 `cleanSearchText`。
- 重构 `src/tools/search/tool.ts` 调用 `deepseekSearch`，`brief` 保持 `cleanSearchText(r.rawSummary, 300) || cleanSearchText(r.rawSnippet, 300)`，`title` 保持 `cleanSearchText(r.rawTitle, 80)`，并传入 `signal: context?.abortSignal`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/deepseek-search.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git1 add src/external/deepseek-search.ts src/tools/search/tool.ts test/deepseek-search.test.ts
git1 commit -m "refactor(search): 抽离 DeepSeek Search 共享客户端并补充单测"
```

---

### Task 2: 在 `src/external/video-links.ts` 增补严格 B 站视频路径 BV 提取器

**Depends on:** `none` *(与 Task 1 无文件重叠)*

**Files:**
- Modify: `src/external/video-links.ts:1-29`
- Modify: `test/video-share.test.ts:41-57`

**Interfaces:**
- Produces in `src/external/video-links.ts`:
  - `export function biliVideoBvidOfUrl(url: string): string | undefined` — 用 `new URL(url)` 解析，仅认 `http:`/`https:` 且主机名（小写）等于 `"bilibili.com"` 或以 `".bilibili.com"` 结尾，且 `pathname` 匹配 `/^\/video\/(BV[0-9A-Za-z]{10})(?:\/|$)/`；其它一律 `undefined`。保留既有 `bvidOfUrl` 语义不变。

- [ ] **Step 1: Write failing test in `test/video-share.test.ts`**

追加测试 `"biliVideoBvidOfUrl 仅认 bilibili.com/video/BV 路径并拦截 av/opus/query/伪造域名"`：
- 通过：`https://www.bilibili.com/video/BV1eqZJYaESc`、`https://www.bilibili.com/video/BV1eqZJYaESc/?spm_id_from=1#2`、`https://m.bilibili.com/video/BV1eqZJYaESc/`、`https://bilibili.com/video/BV1eqZJYaESc` → 均返回 `"BV1eqZJYaESc"`。
- 拒绝：`https://www.bilibili.com/video/av115138879295226/`、`https://www.bilibili.com/opus/123?ref=BV1eqZJYaESc`、`https://www.bilibili.com/read/cv123/BV1eqZJYaESc`、`https://bilibili.com.evil.example/video/BV1eqZJYaESc`、`https://evil.example/video/BV1eqZJYaESc`、`javascript:https://www.bilibili.com/video/BV1eqZJYaESc`、`not-a-url` → 均返回 `undefined`。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/video-share.test.ts`
Expected: FAIL（`biliVideoBvidOfUrl` 未导出）

- [ ] **Step 3: Implement `biliVideoBvidOfUrl` in `src/external/video-links.ts`**

在 `src/external/video-links.ts` 导出 `biliVideoBvidOfUrl(url: string): string | undefined`。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/video-share.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git1 add src/external/video-links.ts test/video-share.test.ts
git1 commit -m "feat(video): 增加 B 站视频路径严格 BV 提取函数"
```

---

### Task 3: 实现 `bili_search`、替换 `bili_hot` 并全仓同步提示词、测试与文档

**Depends on:** `Task 1`, `Task 2`

**Files:**
- Create: `src/tools/bili_search/TOOL.md`
- Create: `src/tools/bili_search/schema.json`
- Create: `src/tools/bili_search/messages.json`
- Create: `src/tools/bili_search/tool.ts`
- Create: `test/bili-search.test.ts`
- Delete: `src/tools/bili_hot/TOOL.md`, `src/tools/bili_hot/schema.json`, `src/tools/bili_hot/messages.json`, `src/tools/bili_hot/tool.ts`
- Modify: `src/tools/loader.ts:36,67-71`
- Modify: `src/tools/bili_video/schema.json:7`
- Modify: `src/tools/bili_video/tool.ts:4,18`
- Modify: `src/tools/video/TOOL.md:24,27`
- Modify: `src/tools/video/tool.ts:16,19`
- Modify: `src/tools/say_words/tool.ts:11,116`
- Modify: `src/tools/ammo_submit/TOOL.md:7`
- Modify: `src/tools/ammo_submit/schema.json:8`
- Modify: `src/tools/types.ts:57-65`
- Modify: `src/app/runtime.ts:966-968`
- Modify: `src/external/ammo-store.ts:6-7,53`
- Modify: `src/external/bili-client.ts:15-16`
- Modify: `src/external/video-browse.ts:14-19`
- Modify: `src/external/video-pool.ts:7,77`
- Modify: `src/external/sanitize.ts:6`
- Modify: `src/qq/curfew.ts:6`
- Modify: `prompt/runtime.md:27`
- Modify: `prompt/messages.md:140-143`
- Modify: `test/tools.test.ts:68`
- Modify: `AGENTS.md:26,331,585-601`
- Modify: `README.md:21,110-116`

**Interfaces:**
- Consumes:
  - `deepseekSearch`, `SearchResponseError`, `cleanSearchText`, `type DeepSeekSearchItem` from `../../external/deepseek-search.ts`
  - `biliVideoBvidOfUrl` from `../../external/video-links.ts`
  - `compileFilterPatterns`, `createBiliFiltersLoader`, `type BiliFilters` from `../../external/bili-client.ts`
  - `VideoPoolDoc`, `activeSeenOf`, `applyVideoPoolSeen`, `videoPoolKeyOf`, `type VideoPoolState` from `../../external/video-pool.ts`
- Produces in `src/tools/bili_search/tool.ts`:
  - `export const DEFAULT_BILI_SEARCH_DAYS = 60`
  - `export const BILI_SEARCH_LIMIT = 10`
  - `export const BILI_SEARCH_FETCH_COUNT = 20`
  - `export const BILI_SEARCH_FALLBACK_MIN = 3`
  - `export const BILI_SEARCH_MAX_PER_ROUND = 2`
  - `export const BILI_SEARCH_TOTAL_TIMEOUT_MS = 24_000`
  - `export const BILI_SEARCH_PRIMARY_TIMEOUT_MS = 14_000`
  - `export interface BiliSearchFunnelStats { raw: number; bili: number; inLibrary: number; hardVeto: number; returned: number; }`
  - `export interface BiliSearchFunnelResult { rows: string[]; stats: BiliSearchFunnelStats; bvids: string[]; }`
  - `export interface BiliSearchToolOptions { search?: typeof deepseekSearch; filters?: () => BiliFilters; audit?: (line: string) => void; }`
  - `export function normalizeBiliSearchQuery(rawQuery: string): string`
  - `export function buildBiliSearchQuery(cleanedQuery: string, days: number, nowMs: number): string`
  - `export function cleanBiliVideoTitle(rawTitle: string): string`
  - `export function runBiliSearchFunnel(items: readonly DeepSeekSearchItem[], limit: number, deps: { filters: BiliFilters; inLibrary: ReadonlyMap<string, string>; audit: (line: string) => void; minPublishedAtMs?: number; }): BiliSearchFunnelResult`
  - `export function createBiliSearchTool(manifest: ToolManifest, deps: ToolPackageDeps, options?: BiliSearchToolOptions): ToolRegistration`

**Exact `src/tools/bili_search/messages.json` keys（10 项，全部在 `tool.ts` 中以 `messages["..."]` 字面量引用，零死文案）：**
1. `bili_search_query`：搜索词长度不对（需要 1 到 80 字）
2. `bili_search_bad_days`：days 必须是 0 到 365 之间的整数
3. `bili_search_nokey`：没有配置搜索凭据，搜不了 B 站视频
4. `bili_search_round_missing`：当前轮次不可用，无法搜索
5. `bili_search_used`：这一轮已经搜过两次 B 站视频了，直接从刚拿到的候选里挑就行
6. `bili_search_failed`：B 站视频搜索没成功（{{query}}）：{{reason}}
7. `bili_search_header`：B 站视频候选（标题|发布|简介|BV）：
8. `bili_search_stats`：（搜索命中 {{raw}} → 有效 B 站视频 {{bili}} → 本群去重 {{in_library}} → 文本过滤 {{hard_veto}} → 返回 {{returned}}{{fallback_note}}）
9. `bili_search_fallback_note`：，近{{days}}天不足已自动放宽时间
10. `bili_search_empty`：这轮没搜到合适的 B 站视频，换个关键词或下次再逛

- [ ] **Step 1: Write failing tests in `test/bili-search.test.ts` and update `test/tools.test.ts:68` (RED)**

在 `test/bili-search.test.ts` 编写以下测试（全部注入 mock `search` 与假 `LiveDoc`/`VideoPoolDoc`）：
1. `"normalizeBiliSearchQuery 与 buildBiliSearchQuery：精准剥离算子、UTF-16 长度边界、UTC+8 跨日切分"`：
   - `"site:zhihu.com -site:x.com after:2020-01-01崩坏3 爱莉希雅 before:2026-01-01"` → `"崩坏3 爱莉希雅"`；
   - `nowMs = Date.parse("2026-11-25T03:00:00+08:00")`（UTC 为 `2026-11-24`，UTC+8 为 `2026-11-25`），`days = 60` → `"site:bilibili.com/video 崩坏3 爱莉希雅 after:2026-09-26"`；
   - `days = 0` → `"site:bilibili.com/video 崩坏3 爱莉希雅"`；
   - 80 个普通汉字 / 40 个 emoji（80 UTF-16 单位）拼完后 `.length <= 128`；41 个 emoji（82 UTF-16 单位）被拒绝。
2. `"cleanBiliVideoTitle 精准去除 B 站页面后缀并兜底空标题"`：
   - `"【LLM雷达图】Fable 5.2_哔哩哔哩_bilibili"` → `"【LLM雷达图】Fable 5.2"`；
   - `"AI 早报 2026-11-10_哔哩哔哩_bilibili - 00:41"` → `"AI 早报 2026-11-10"`；
   - `"《崩坏3》爱莉希雅_哔哩哔哩bilibili_崩坏3"` → `"《崩坏3》爱莉希雅"`；
   - `"【崩坏3】爱愿妖精登场_游戏热门视频"` → `"【崩坏3】爱愿妖精登场"`；
   - `"_哔哩哔哩_bilibili"`（剥离后为空）→ `"无标题"`。
3. `"runBiliSearchFunnel：严格 /video/BV 过滤、多锚点 BV 去重、inLibrary 剔除、minPublishedAtMs 兜底、4 条文本硬筛、优先 snippet、无 URL 与竖线冲突"`：
   - 验证非 B 站、`/video/av123`、`/opus/456`、超窗旧日期条目被丢弃；`publishedAtMs` 缺失条目保留并渲染 `"日期未知"`；同 BV `#2/#5` 只留首条；`inLibrary` 剔除并审计；命中 `titleBait`/`uc`/`listicle`/`promoDesc` 否决并审计且审计行不含标题/简介原文；正常条目优先 `snippet`（空时取 `summary` 首行去 `#` 前缀），`extractLinks(rows.join("\n"))` 为空，字段内 `|` 替换为 `｜`。
4. `"createBiliSearchTool：缺省 days=60 生效；近 60 天结果 < 3 条自动放宽重搜合并去重（时间窗优先）并记账 seen"`：
   - 不传 `days` 时验证首次收到 `after:YYYY-MM-DD`（60 天前），返回 1 条（A）→ 自动发起无 `after:` 二次调用返回 A + B + C → 输出顺序 A, B, C，尾行含 `bili_search_fallback_note`，`VideoPoolDoc` 写入 A/B/C 为 `seen`。
5. `"createBiliSearchTool：放宽重搜抛 SearchResponseError 时保留首次 1-2 条结果（不标已放宽）；0 条且 SearchResponseError 抛 bili_search_failed；网络错误/AbortError 原样上抛且不写 seen/不扣额度"`。
6. `"createBiliSearchTool：参数/凭据/轮标识/每轮 2 次上限校验"`：
   - 缺 `searchKey` 报 `bili_search_nokey`；非法/空/超 80 单位 `query` 报 `bili_search_query`；非法 `days`（`-1`/`366`/`1.5`）报 `bili_search_bad_days`；缺 `live.run.inputs[0]` 报 `bili_search_round_missing`；成功 2 次后第 3 次报 `bili_search_used`；空结果释放不计数。
7. `"createBiliSearchTool：context.abortSignal 中止时中止底层请求、不记账 seen、不占用额度；与 search 租约互不干扰"`。

同步将 `test/tools.test.ts:68` 的 `"bili_hot"` 改为 `"bili_search"`。

- [ ] **Step 2: Run targeted tests to verify they fail**

Run: `node --test test/bili-search.test.ts test/tools.test.ts`
Expected: FAIL（`bili_search` 尚未实现，`loader.ts` 仍注册 `bili_hot`）

- [ ] **Step 3: Implement `src/tools/bili_search/`, wire `loader.ts`, delete `src/tools/bili_hot/`, and sync all prompts, comments, and docs**

- 创建 `src/tools/bili_search/{TOOL.md,schema.json,messages.json,tool.ts}`：
  - `schema.json` 只写 `query`（required string）与 `days`（optional integer, minimum 0, maximum 365），不写 `default`，`additionalProperties: false`；`execute` 内用 `args.days ?? DEFAULT_BILI_SEARCH_DAYS`。
  - `TOOL.md` 说明按关键词搜 B 站视频、默认近 60 天、支持传 `days: 0` 不限时间、7 天内同群展示去重（已分享永久排除）、一轮最多搜 2 次、返回 `标题|发布|简介|BV`（无链接）、必须用 `video` 真看后再用 `say_words` 分享链接。
  - `tool.ts` 实现 `BILI_SEARCHED` 按 `(conversationId, round)` 计数（并发原子占位，空结果/报错/中止递减释放，上限 `BILI_SEARCH_MAX_PER_ROUND = 2`）、总超时 24s 预算分摊与 `context?.abortSignal` 透传、提交 `applyVideoPoolSeen` 前再次检查 `context?.abortSignal?.aborted`。
- 删除 `src/tools/bili_hot/` 目录；更新 `src/tools/loader.ts` 注册 `bili_search: createBiliSearchTool`（同步修正注释中的工具包数量说明）。
- 更新 `prompt/runtime.md:27` 与 `prompt/messages.md:140-143`：告知模型在 `[主动交流机会]` 下可结合自己的人格兴趣或群里最近的话题，调用 `bili_search` 传关键词搜 B 站视频候选，挑中后再用 `video` 实际观看并决定是否用 `say_words` 分享链接。
- 更新 `src/tools/bili_video/schema.json`、`src/tools/bili_video/tool.ts`、`src/tools/video/TOOL.md`、`src/tools/video/tool.ts`、`src/tools/say_words/tool.ts`、`src/tools/ammo_submit/{TOOL.md,schema.json}` 及所有 `src/` 注释（包含 `src/external/ammo-store.ts:6-7,53`、`src/external/bili-client.ts:15-16`、`src/external/video-browse.ts:14-19`、`src/tools/types.ts:57-65`、`src/app/runtime.ts:966-968`、`src/external/video-pool.ts:7,77`、`src/external/sanitize.ts:6`、`src/qq/curfew.ts:6`——如实注明 `bili_search` 不再消费 `browseTopic`，`VIDEO_TOPICS` 仅作历史触发字段兼容保留）。
- 更新 `AGENTS.md`（工具清单、§自由拍、§17 自主浏览：写明 `bili_search` 基于 DeepSeek Search 过滤 B 站视频、默认 60 天自动放宽、零 B 站配额、每轮最多 2 次、保留 `fish.video_pool` 与文本硬筛）与 `README.md`。

- [ ] **Step 4: Run full test suite, prompt audit, and strict grep gate**

Run:
```bash
npm test && npm run prompts && ! rg -n "\bbili_hot\b" src/ prompt/ test/ AGENTS.md README.md
```
Expected:
- `npm test` 全部通过（0 fail，含新增 `test/deepseek-search.test.ts` 与 `test/bili-search.test.ts`）；
- `npm run prompts` 正常输出，包含 `bili_search` 且不含 `bili_hot`；
- `! rg ...` 退出码为 0（0 处残留 `bili_hot`）。

- [ ] **Step 5: Commit**

```bash
git1 add src/tools/bili_search src/tools/bili_hot src/tools/loader.ts \
  src/tools/bili_video/schema.json src/tools/bili_video/tool.ts \
  src/tools/video/TOOL.md src/tools/video/tool.ts src/tools/say_words/tool.ts \
  src/tools/ammo_submit/TOOL.md src/tools/ammo_submit/schema.json \
  src/tools/types.ts src/app/runtime.ts \
  src/external/ammo-store.ts src/external/bili-client.ts \
  src/external/video-browse.ts src/external/video-pool.ts \
  src/external/sanitize.ts src/qq/curfew.ts \
  prompt/runtime.md prompt/messages.md \
  test/bili-search.test.ts test/tools.test.ts \
  AGENTS.md README.md
git1 commit -m "feat(bili_search): 用 bili_search 替换 bili_hot 并同步提示词与文档"
```

---

## Independent Plan Review 记录

- **Reviewer**：`pi-worker`（`tier: "heavy"`, `readOnly: true`, model `glm-5.4`, task `2a5b84ed-6622-4c8c-afd8-5ce707c204e2`）。
- **已全部采纳并修订入计划的 Critical / Suggestion / Minor**：
  - **C1（红 commit）**：合并原 Task 2/3，确保 `src/tools/bili_search/` 与 `loader.ts` 切换及 `bili_hot` 删除在同一提交完成，无红 commit。
  - **C2（30s 超时与租约/池污染）**：`deepseekSearch` 新增 `signal` 透传 `context.abortSignal`，`bili_search` 两次请求共享 24s 总预算（首呼 ≤14s），写 `seen` 前复查 `abortSignal`，中止不扣额度不写池。
  - **S1–S10**：补入 `src/external/ammo-store.ts` 清理；如实更新 `browseTopic`/`VIDEO_TOPICS` 注释并补充主动交流机会选词引导；单轮限额放宽至 2 次（支持换词重试一次）；补充客户端 `minPublishedAtMs` 时间窗兜底；`brief` 优先 `snippet` / 首段 `summary` 避免侧栏误杀；`createSearchTool` 支持 `fetch` 注入并锁定原有截断/优先序回归测试；列出全部 10 个 `bili_search_*` 文案 key 并覆盖 `bili_search_round_missing`；移除 `schema.json` 无效 `default` 注解；统一错误分类与降级提示；用显式文件路径替代 `git1 add -A`。
  - **M1–M8**：修正精确行号、UTC+8 跨日用例（`03:00+08:00`）、UTF-16 `.length` 一致性、算子剥离正则边界、标题四样例精确期望与空标题兜底、严格 `! rg` 门禁及任务拆分为 3 个独立语义提交。
- **未解决 / 延后项**：无。`M9`（`seen` 7 天去重在自由关键词搜索下的语义）已按用户确认保留并在 `TOOL.md` 中明示。
