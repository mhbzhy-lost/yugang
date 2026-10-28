# HANDOFF

换机器继续时先读这一篇。架构约束在 `AGENTS.md`，运维手法在 `.agents/skills/ops/SKILL.md`。

## 现在在哪

代码写完了，测试 48 项全绿（`npm test`，不需要网络和 key），模型链路已验证（`npm run ping` 通过）。
**唯一没通的是 QQ 侧**：协议端（NapCat）已下载、配置已写好，但还没登录——需要人扫码。

```
群消息 → 闸（规则/抽样/打分）→ conversation.submit() → agent loop
                                                         ├── thinking/正文/tool  ✗ 不出境
                                                         └── say / react / look
                                                               → 硬校验 → outbox → QQ
```

## 到新机器后的前五步

```bash
git clone <repo> && cd yugang
npm install                     # 项目 .npmrc 钉的是官方源

# 1. 重建凭据（不进仓库，必须重新导）
npm run creds import            # 从 ~/pi-config/pi/auth.json 导
#   或手写 config/auth.json：{ "qoder-pool": { "key": "..." } }

# 2. 重建 .env
cp .env.example .env
#   填 ONEBOT_WS_URL / MASTER_QQ / GROUPS
npm run token                   # 生成 ONEBOT_TOKEN，同步写进 NapCat 配置

# 3. 装协议端
brew install --cask qq                              # macOS 需要 Mac 版 QQ
npm run protocol install                            # 写 NapCat 的 onebot.json
#   打开 ~/Downloads/NapCatInstaller/NapCatInstaller.app（别人的机器上要重新下：
#   https://github.com/NapNeko/NapCat-Mac-Installer/releases）
#   安装 → 切换程序入口 NapCat → 启动 QQ → 扫鱼号的码

# 4. 体检
npm run doctor                  # 应该全绿
npm run probe                   # 报出鱼的昵称和所在群

# 5. 起
npm run up                      # Ctrl-C 一起收；npm run down 也能收
```

Linux 机器上协议端更简单：`npm run protocol install` 会下载 NapCat Shell 包到 `var/protocol/napcat`，
起它、扫码即可，不需要 Mac 安装器。

## 立刻要验证的三件事

1. **群里 @ 它一句** —— 3 秒内应该回，且回的是 1~3 条短句（拆条 + 抖动在起作用）
2. **`look` 到底通不通** —— 群里发张图让它看。`config/models.json` 里声明了 `input: ["text","image"]`，
   但**没有验证过这个网关是否真的转发图片**。如果它答非所问，八成视觉没通，把 `input` 改成 `["text"]`。
3. **`npm run ops digest` / `npm run ops usage`** —— 确认原话簿和用量都在写

## 未完成，按优先级

| # | 事项 | 为什么现在没做 | 从哪下手 |
|---|---|---|---|
| 1 | 视觉验证 | 需要真群 + 真图 | 群里发图，看 `look` 返回后模型说得出颜色吗 |
| 2 | macOS 协议端跑通 | 需要扫码 + 系统权限 | 见上面第 3 步；版本不兼容就 `brew upgrade --cask qq` |
| 3 | 语音（STT 收 / TTS 发） | 群里发语音很常见，现在听不懂 | 参考 dsh-onebot-qq：whisper 转写 + SILK 编码 |
| 4 | 表情包库（入库/去重/分类/挑图） | 最出彩但最费工 | 参考 dsh-qqbot 的图库 + `astrbot_plugin_meme_manager` |
| 5 | 长文转图 / 合并转发 | 长回复现在会被 120 字上限拒绝 | 参考 dsh-onebot-qq 的 `textImageThreshold` |
| 6 | 群管理（审批、禁言） | 合规风险高，最后再做 | 参考 dsh-qqbot 的"锤子"（走群官网扫码） |

明确**不做**的：Web 管理后台（用 `.agents/skills/ops` 代替）、主动定时推送、好感度系统、MCP。

## 已知的坑

- **Mac QQ 版本**：本机装的是 7.0.0，NapCat 官方核验过的是 7.0.2-53644。安装器报不兼容就升级 QQ。
- **`npm run token` 会轮换**：重跑会换新 token，`.env` 和 NapCat 配置一起变，等于踢掉已登录的连接。只在第一次用。
- **NapCat 在 Docker 里时媒体路径不通**：`say.media` 传的是宿主机绝对路径，容器里看不到。要么两边挂载一致，要么改 base64。
- **`AMBIENT_CHANCE=1` 只适合测试**：真挂群建议 0.05~0.1，否则它会变成刷屏机器。
- **`MESSAGE_POST_FORMAT` 必须是 array**，且 `reportSelfMessage` 必须 false，否则鱼会跟自己聊起来。

## 绝不要提交的东西

`.env`（含 ONEBOT_TOKEN）、`config/auth.json`（含模型 key）、`var/`（数据库、原话簿、媒体）。
前两个在 `.gitignore` 里，且 `npm test` 有一条测试盯着 `config/auth.json` 是否被忽略。

## 关键文件

| 文件 | 作用 |
|---|---|
| `src/harness.ts` | 组装：storage + models + 工具注册表 + 群会话 + outbox drain |
| `src/egress/policy.ts` | 出口校验（结构 + 溯源），返回错误码 |
| `src/egress/say.ts` | 唯一出口，落 outbox |
| `src/qq/gate.ts` | 门口三层闸 |
| `src/compact.ts` | 换页 + handoff |
| `src/tools/` | 能力扩展点（现在只有 `look`） |
| `prompt/` | 模型能看到的一切文字，改行为改这里 |
| `config/models.json` | provider 地址与模型清单（不含 key） |
