# IT bed 测试设施（scripts/itbed/）

本地集成测试环境（IT bed）的脚本与设施，计划见 `docs/plans/2026-11-03-itbed.md`。
当前进度：**Task I0（parity 清单与校验）已交付**；I1 起的 faux NapCat / sandbox 启动器 / 场景驱动器在本目录继续追加。

---

## parity：与 macmini 的环境一致性（Task I0）

IT bed 的口径是「与生产上层能力一致」，一致性靠**清单 + 校验脚本**保证：

| 层 | 一致方式 |
|---|---|
| prompt/、src/、personas | 同 repo 同 commit（manifest 记 macmini HEAD，check 时对本地 HEAD） |
| fish.config.json | manifest 存 macmini 快照（含 ambient=120、compact 阈值、voices 音色名等），场景可覆盖压缩时窗 |
| .env | manifest 存键清单与值（token 类脱敏），I2 启动器沿用它拼 sandbox 的 .env（GROUPS/master 沿用、ONEBOT_* 换 faux 值） |

### 文件

| 文件 | 作用 |
|---|---|
| `parity/pull-parity.ts` | 从 macmini 只读拉取，生成 `parity/parity-manifest.json` |
| `parity/check-parity.ts` | 本地工作区 vs manifest 三项比对，输出逐项表 |
| `parity/parity-manifest.json` | 快照本体（入库；不含任何 secret） |

### 怎么重新拉取

```bash
node scripts/itbed/parity/pull-parity.ts
```

前置：home-mac-connect skill 的凭据在位（`~/.agents/skills/home-mac-connect/`，可用 `ITBED_CONNECT_SH` 换路径）。
远程只有三条只读命令：`echo $HOME`、`git rev-parse HEAD`、`cat fish.config.json`、`cat .env`（经 connect.sh，不写 macmini 任何文件）。

拉完后 **先 `git diff scripts/itbed/parity/parity-manifest.json` 人看一眼再入库**——manifest 是生产快照，它的每次变化都意味着线上参数变了，IT 场景基线要跟着确认。

### 何时需要重新拉取

- macmini 部署了新 commit（check-parity 会报 git HEAD 阻塞差异）；
- 线上 fish.config.json 或 .env 变更（config 工具改参、新增群、换协议端地址等）；
- IT bed 场景要吃新的生产参数基线（如 engage/ammo/news 调参后写新场景）；
- manifest 里 `source.pullMode` 是 `manual-fallback`（见下）时，macmini 恢复可达后补一次真拉取。

### 校验

```bash
node scripts/itbed/parity/check-parity.ts                # 用入库 manifest
node scripts/itbed/parity/check-parity.ts --manifest <path>  # 用指定 manifest（做假设验证用）
```

退出码：`0` 无阻塞差异；`1` 有阻塞差异（逐项列出）；`2` 无法比对（manifest 缺失/损坏、git 不可用）。

结果分级：

- **一致**：两边对得上；
- **提示**：预期内的非阻塞差异——线上未显式配置的字段（本地代码有内置缺省）、example 未收录的遗留/可选键（macmini .env 里的旧限流变量等）、手工兜底来源待补；
- **差异（阻塞）**：真实的 parity 断裂——git HEAD 不一致、本地 schema 不认识的 fish.config 键（本地代码会忽略它，行为面对不上）、必填五键（ONEBOT_WS_URL/ONEBOT_TOKEN/MASTER_QQ/GROUPS/PROTOCOL_QQ）缺一。

比对口径说明：**只比结构与身份（键集 / schema 白名单 / commit），不比具体值**。fish.config 生产值覆盖模板、.env 值因机器而异都是预期差异；开发期本地领先线上 commit 也是常态，git HEAD 的阻塞差异按「部署对齐或确认接受」处理。

### 脱敏约定（manifest 可安全入库）

- 真正脱敏的只有 **token/密钥类**：键名命中 `/TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|KEY/i` → 值记 `<redacted:len=N>` 长度占位（ONEBOT_TOKEN、MODELSCOPE_KEY 等）；
- **MASTER_QQ / GROUPS / PROTOCOL_QQ / ONEBOT_WS_URL 保留**：IT bed 的 faux 注入要用主人身份与群号，地址与 QQ 号不是凭据；
- fish.config.json 里的**人名备注与音色名保留**（场景断言要用）；voices 的本机路径与参考音频原文一并保留；
- 兜底防线：所有保留值过一遍 URL userinfo 守卫（`scheme://user:pass@host` → `scheme://user:<redacted>@host`），防代理地址夹带凭据；每次脱敏命中都记录在 manifest 的 `redactions` 数组里可审计；
- .env 原文只在 pull 脚本进程内存活，任何日志/失败路径都不打印。

### macmini 不可达时的手工兜底

按计划的停止条件：macmini 连不上时**不自动伪造**，由人用本地 var 副本手工构造 manifest，并把 `source.pullMode` 改为 `"manual-fallback"`、注明来源待补；check-parity 会因 pullMode 显式提示「非实时拉取」。macmini 恢复后重跑 pull-parity.ts 覆盖即可。
