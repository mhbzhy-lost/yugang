# engage next-only + 弹药补货 运行记录（2026-11-04）

> 手动编排执行（goal 实例 b93ae48c 因引擎缺陷④死锁后废弃，见 docs/investigations 报告于 ~/pi-config）。
> 本文件是 F2/F4 的证据位置；F1/F3 证据见各节命令输出。

## 提交

| commit | 内容 | 验收 |
| --- | --- | --- |
| `81dc5f3` feat(ammo): 弹药库改为空库自动补货的事件驱动模式 | T1：refillTarget=5/30min 冷却/双挂点/预算分家（executor run 8bd518a5 + 复活 run ebb0e5ec，集成队列 rebase-ff 发布） | npm test 102/102（执行时基线） |
| `d9fc95c` refactor(engage): 下线 legacy 搭话判定 | T2：gate/engage-next/fish-config/index/watch/config TOOL/.env.example/AGENTS/文案/测试（delegate run 7feae6e3，队列 fast-forward） | npm test 94/94 + tsc + 18/18 判定矩阵 |

推送：`3008225..d9fc95c main -> main`（用户授权，02:2x）

## mini 配置迁移（备份 .env.bak-20261104-t3 / fish.config.json.bak-20261104-t3）

- `.env`：`GROUPS=659976571,184875934,174408629`（崩坏狗窝启用）
- `fish.config.json`：删 `engagement`/`engage`（整块，仅含 groups）/`ambientMinIntervalSeconds`/`watchAmbientChance`；`ammo.slots=[]`（保留 shareChance 0.3）
- 迁移后 keys：`ammo, compact, memeCooldownMinutes, news, thinkingLevel, toolTimeoutSeconds, voices, weeklyGroupId`

## F2：三群 next 启动行（部署 02:31:54 后）

```
[02:31:55] [鱼缸] 搭话开窗 next 启动 qq:group:659976571：closed 从零计时
[02:31:55] [鱼缸] 搭话开窗 next 启动 qq:group:184875934：closed 从零计时
[02:31:55] [鱼缸] 搭话开窗 next 启动 qq:group:174408629：closed 从零计时
```

✅ 三群齐备（174408629 首次进 next，此前任何 boot 最多双群）。

## F4：新闻目标群

`python3 -c "…['news']['targetGroup']"` → `659976571` ✅ 未回归。

## F1 / F3（部署前在本地 main=d9fc95c 复验）

- F1：`npm test` → `tests 94 / fail 0` ✅
- F3（注：契约命令有 `createConfigLoader(...)` 单调用 bug，实际需 `(...)(​).config` 双调用；以下为修正版输出）：
  `{"slots":0,"refill":5,"hasEngagement":false,"hasEngageGroups":false,"hasAmbient":false,"hasWatch":false,"engageKeys":7}`
  + `grep -c "opts?.maxPicks ?? ammo.maxPicksPerRun" src/index.ts` → `2` ✅

## F5（观察项，不阻塞终态）

空库自动补货：库内尚有 3 条 available（TTL 至 11-05 18:00/18:54）。全部消费/过期后，
`maybeRefillAmmo`（5 分钟扫描 + 分享后即时，30 分钟冷却）应起补货逛轮，日志关键词「补货逛轮」。

## 部署横幅

```
[02:31:54] [鱼缸] 凭据 已加载 / 49 字符
[02:31:54] [鱼缸] 已连接，模型 zai-coding-cn/glm-5.3-flash，工具 ammo_list、ammo_submit、bili_hot、bili_video、config、draw、gpt_image、grep、look、meme、meme_add、meme_import、react、read、restart、say_media、say_meme、say_voice、say_words、search、tags、tool_search、tree、video、watch、write
[deploy] ✓ 语音实例就绪
```
