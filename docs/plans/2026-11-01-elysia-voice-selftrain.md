# 爱莉希雅语音自训与上线 实现计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。只有整体交付终态全部验证通过，才算计划执行完成；未满足时持续修复与验证。执行方式由计划编写完成后的用户选择决定。

**目标：** 用已落位的 B站爱莉希雅语音语料，在 Windows（RTX 5090 D）训练 v2ProPlus 与 v4 两版 GPT-SoVITS 音色，经客观 AB 与试听后切换鱼缸现役爱莉希雅语音，解决「吐字不清晰、错字错音」。

**架构：** 语料在 Windows `D:\datasets\elysia\` 清洗、FunASR 打标后走官方 GPT-SoVITS 管线双版本训练；ckpt 拷回 macmini 以新端口（9883/9884）起并行试听实例，与现役 9880（v2 旧模型）做固定句集 AB（ASR 回转字错率 + 耗时 + 人工试听）；胜者切换 `fish.config.json` voices 并调整超时后 deploy 上线；旧实例全程保留可回滚。

**技术栈：** GPT-SoVITS 官方仓库（`D:\GPT-SoVITS\GPT-SoVITS` @04a44eb，conda env `gptsovits`，torch 2.8.0+cu128）、FunASR（打标与回转评测）、macmini launchd + api.py（9880/9881/9882 现役）、鱼缸仓库（pi-durable / TypeScript）。

## 全局约束

- **现役实例不可动**：9880/9881/9882 三个 launchd 服务、其 plist、权重、参考音频，在 T8 切换前一律不修改、不重启；新模型只上新端口 9883（v2ProPlus）/ 9884（v4）。
- **三台机器操作只经 skills**：`~/.agents/skills/home-mac-connect/SKILL.md`、`~/.agents/skills/home-windows-connect/SKILL.md`、`~/.agents/skills/home-lan-connect/SKILL.md`；禁止自拼 ssh/scp；不读任何凭据文件。
- **Windows 显存竞争**：SD WebUI 原生常驻（~3.9G）；vLLM（WSL，现 stopped）拉起期间不得开训；每次训练启动前 `nvidia-smi` 确认可用余量 ≥16G。
- **长任务一律后台化**：nohup / 后台 + 日志文件落盘，SSH 会话断开不致死；恢复时先查日志断点。
- **仓库改动范围仅限**：`src/tts.ts`（合成超时默认值与 `TtsConfig` 注释）、`src/index.ts`（`toolTimeoutOverrides` 增加 `say` 条目）、`AGENTS.md`（语音节/§15 数值同步、过期欠账改写）；macmini 的 `fish.config.json`（仅 voices 切换；`toolTimeoutSeconds` 保持 30 不动）。其余仓库文件不动。
- **不新增测试**（只跑既有 `npm test`）；**不 commit**（T8 内显式请求授权，deploy 以 commit+push 获准为前置）。
- **素材封闭**：音频只用已落位语料 `D:\datasets\elysia\`，不新增音频下载；HF 文本对照语料允许下载，落 `D:\datasets\elysia\hf-corpus\`（爱莉 1,669 句，调研报告见 `.pi/subagents/artifacts/4ade7ad6-75ad-49cb-9ea4-3c9676fb22c4_executor_output.md`；该语料经 OCR+VLM 生成，自带识别误差）。
- **证据落盘**：Windows 侧统一 `D:\datasets\elysia\reports\`；macmini 侧用其日志与 `~/tts/audition/elysia-ab/`；AB 样本保留原始 wav。
- 计划未采用 Goal Runtime v1 契约（会话未注册 `plan_execute`），按普通计划执行。

## 整体交付终态

| ID | 必须成立的条件 | 验证方法与环境 | 通过判据 | 证据位置 | 覆盖任务 |
| --- | --- | --- | --- | --- | --- |
| F1 | 清洗后训练集与标注就位 | 读 `D:\datasets\elysia\reports\T2-dataset-qa.md` + 抽看 `.list` 与音频目录（Windows） | `.list` 行数=音频文件数；可用条目 ≥400 条；抽查 30 条标注错字合计 ≤3 处；时长分布已记录 | T2 报告 + `logs/elysia/` 数据目录 | T1, T2 |
| F2 | 双版本 ckpt 产出且本机可用 | Windows `gptsovits` 环境命令行各合成 1 句附录 A 第 1 句（api 或推理脚本） | v2ProPlus 与 v4 各产出 GPT+SoVITS ckpt；两次冒烟均出 >50KB 可解析 wav；训练日志无 NaN | `D:\datasets\elysia\reports\T4-train-v2pp.md`、`T5-train-v4.md` + ckpt 路径 | T4, T5 |
| F3 | macmini 试听实例常驻 | macmini：`lsof -i :9883 -i :9884`、curl 各试合成 3 句；对照 9880-9882 前后进程/端口清单 | 9883/9884 LISTEN 且合成 200、音频 >50KB；9880-9882 实例 pid/端口与开工前一致 | macmini `~/tts/elysia2.log`/`elysia4.log` + `D:\datasets\elysia\reports\T6-deploy.md` | T6 |
| F4 | 客观 AB 对比完成 | 附录 A 全 16 句在 9880/9883/9884 同参数合成；FunASR 回转转写算逐句编辑距离/字错率 + `time_total` 耗时（Windows 计算） | 三实例全指标实测成表；**至少一个新版本字错率相对 9880 基线下降 ≥30%**；新版本最长句耗时 ≤90s | `D:\datasets\elysia\reports\T7-ab.md` + 样本目录 | T3, T7 |
| F5 | 胜者上线且配置生效 | 先 commit+push 获准并 `fish.sh deploy`（新代码上线、voices 仍指 9880），后切 `fish.config.json` voices；deploy 后远程核对 macmini `~/yugang/src/tts.ts` 超时默认值；上线后看胜者实例日志 | npm test 全绿；deploy 横幅正常；macmini 现役 tts.ts 超时默认值=新值；`voices.爱莉希雅` 生效（voices 为热加载）；切换时间点之后胜者实例日志出现 ≥1 次 **POST** 200（GET 不计，由用户在群里触发一轮语音） | macmini 日志 + `D:\datasets\elysia\reports\T8-switch.md` | T8 |
| F6 | 可回滚 | 核对 9880 plist/权重/参考音频未动，voices 原值已记录于 T8 报告 | 回滚步骤可执行（voices 指回 9880 即回滚），写入报告 | T8 报告 | T6, T8 |

**完成规则：** 所有必要条件同时满足，且验证证据对应当前交付版本，才能标记计划执行完成；仅完成任务步骤不能替代终态验证。

**未满足时：** 在已授权范围内持续 `fix → test（验证）→ 对照终态`；真实阻塞记录为未完成并写明恢复下一步。F4 的字错率 ≥30% 判据未达标时：先按 T4/T5 的调参预案复训一轮，仍不达标则向用户报告实测量，由用户决定是否放宽或改路线。F4 的「最长句 ≤90s」属 macmini MPS 推理速度问题，**复训无法改善**：未达标时如实报实测耗时，由用户决定放宽上限或改选另一版本。

## DAG

```text
T1 (语料落位清洗) ──> T2 (数据集构建标注) ──> T4 (v2ProPlus 训练) ──┐
                                  └────────> T5 (v4 训练) ─────────┤
T3 (基线测量，独立) ─────────────────────────────────────────────────┤
                                                                     v
                                              T6 (macmini 试听实例) ──> T7 (AB 对比) ──> T8 (切换上线)
```

- T2→T4/T5：消费 T2 产出的 `logs/elysia` 数据集与 `.list`（数据依赖）。
- T4/T5 之间**无依赖边**：共享 5090 GPU 属资源竞争，在 Resources 声明互斥串行。
- T3 独立：只需现役 9880 + Windows FunASR。
- T6 消费 T4/T5 的 ckpt；T7 消费 T3 的基线与 T6 的实例；T8 消费 T7 的胜者决策。

## Waves

- Wave 1：T1、T3（可并行）
- Wave 2：T2
- Wave 3：T4、T5（GPU 互斥，执行器串行调度，先后不论）
- Wave 4：T6
- Wave 5：T7
- Wave 6：T8（含用户试听决策门）

**关键路径：** T1 → T2 → T4/T5 → T6 → T7 → T8；T3 不在关键路径上，可与 T1 并行尽早完成。

---

### Task 1：语料 LAN 落位与核对（Windows）

**Deps：** `none`（前置已就绪：语料已在 macmini 解压并完成全量盘点，报告：`.pi/subagents/artifacts/53dc3183-a2bb-4262-96c2-2759223d4d8e_executor_output.md`）

**WritePaths：** 仓库无写入；远端写 macmini `/tmp/elysia_lan.tar`（暂存，验证后删）、本地 `/tmp/elysia_lan.tar`（暂存，验证后删）、`D:\datasets\elysia\`（最终数据）

**Resources：** macmini（打包）+ 本地 + Windows；全程 LAN；与其它任务无冲突

**Files：**
- Create：`D:\datasets\elysia\uvr5\`（1183 wav）、`D:\datasets\elysia\sliced\`（749 wav）、`D:\datasets\elysia\reports\T1-inventory.md`

**接口契约：**
- Consumes：macmini `~/tts/datasets/elysia/语音/` 三档（盘点报告为权威：`2切片后` 749 wav+7 pkf、`3处理后` 1183 wav）；home-mac-connect 新命令 `get-lan`
- Produces：Windows 上 UVR5 档与切片档（ASCII 路径），计数/字节数与盘点一致，供 T2 直接消费

**终态关联：** `F1`（数据集就位）

**验收标准：**
- [ ] 步骤 1：核对 macmini 源——三档目录与盘点报告一致（1183/749/261）；`1未处理` **不传输**（留 macmini 作源备份）
- [ ] 步骤 2：打包——macmini 上把 `3处理后`（改名为 `uvr5/`）与 `2切片后`（改名为 `sliced/`，剔除 7 个 .pkf；子目录映射为 ASCII 名，映射表记录）打成单个 tar；`connect.sh get-lan` 拉到本地（先 lan-check）；**全程禁用中继 get**
- [ ] 步骤 3：LAN 传 Windows——经 home-windows-connect 的 LAN 入口（large-check 通过后）传到 `D:\datasets\elysia\` 并解包（tar 内容已全 ASCII，规避代码页问题）
- [ ] 步骤 4：核对——uvr5 1183 个、sliced 749 个，字节总量与 macmini 侧一致（双端 manifest sha256 或字节数+抽样 sha）；抽查 5 条 ffprobe 时长/采样率
- [ ] 步骤 5：写 `T1-inventory.md`（引用 macmini 盘点报告 + Windows 落位清单 + 目录映射表）；清理三处暂存（macmini /tmp tar、本地 /tmp tar、本地 `/tmp/elysia_tx` 旧中继分卷）

---

### Task 2：训练集构建与标注 QA（Windows）

**Deps：** `T1`（消费其清洗后 UVR5 档目录与清单）

**WritePaths：** 仓库无写入；远端写 `D:\GPT-SoVITS\GPT-SoVITS\logs\elysia\`（实验目录）与 `D:\datasets\elysia\reports\T2-dataset-qa.md`

**Resources：** Windows 机器；GPU 可用（1b/1c 特征提取轻量，与 SD WebUI 共存即可）

**Files：**
- Create：`logs/elysia/`（1a 产物 `.list` 等）、`D:\datasets\elysia\reports\T2-dataset-qa.md`

**接口契约：**
- Consumes：T1 的 UVR5 档音频目录
- Produces：`logs/elysia` 完成官方管线 1a（ASR 打标）/1b（BERT）/1c（SSL）三步的数据集，`.list`（格式 `wav路径|爱莉希雅|ZH|文本`），供 T4/T5 直接训练

**终态关联：** `F1`

**验收标准：**
- [ ] 步骤 1：时长过滤——UVR5 档剔除 <1.5s 与 >20s 的条目（GPT-SoVITS 训练惯例 3-10s 最佳，边界放宽记录于报告）
- [ ] 步骤 2：官方管线 1a——按仓库 webui/docs 流程对 UVR5 档跑数据集格式化 + ASR 打标，**ASR 后端选 funasr**（faster-whisper 缺 onnxruntime CPU 包）；实验名 `elysia`
- [ ] 步骤 3：标注 QA——①下载 HF 对照语料到 `D:\datasets\elysia\hf-corpus\`，按剧情台词文本匹配；**匹配命中≠必改**（对照语料自带 OCR 误差），改动前听音频复核；②人工抽查 30 条重点看多音字与游戏专名（逐火/乐土/英桀/律者/爱莉希雅）；③错标即改 `.list`；全部记录进 QA 报告
- [ ] 步骤 4：官方管线 1b/1c——BERT 与 SSL 特征提取跑完（完成日志为证）
- [ ] 步骤 5：写 `T2-dataset-qa.md`：条目数（F1 判据 ≥400）、时长分布、抽查错字数（≤3）、修正清单、1a/1b/1c 参数
- [ ] 预案（仅当 T1 判定 UVR5 档 <400 条）：用已装的 UVR5 权重对 `2切片后` 档自洗（人声分离参数记录），产出替代训练集，流程同上

---

### Task 3：现役模型基线测量（macmini + Windows）

**Deps：** `none`

**WritePaths：** 仓库无写入；远端写 macmini `~/tts/audition/elysia-ab/9880/`（样本）与 `D:\datasets\elysia\reports\T3-baseline.md`

**Resources：** macmini 9880 实例（只读调用）；Windows FunASR 环境

**Files：**
- Create：样本 wav ×16、`T3-baseline.md`

**接口契约：**
- Consumes：附录 A 固定句集（本计划内嵌）
- Produces：9880 基线指标表（逐句字错率 + 耗时），供 T7 对比；样本命名规范 `{端口号}_{句序号}.wav` 供 T7 复用

**终态关联：** `F4`（基线半边）

**验收标准：**
- [ ] 步骤 1：macmini 上对 9880 逐句合成附录 A 全 16 句（curl 老版 GET，`text_language=zh`，默认参考音频），记录 `http_code/size/time_total`，wav 存 `~/tts/audition/elysia-ab/9880/`
- [ ] 步骤 2：样本传 Windows（小文件，走既有传输路）
- [ ] 步骤 3：Windows `gptsovits` 环境用 FunASR 逐句转写，**转写与参考文本先归一化**（去标点、数字↔汉字互转如 3↔三、繁简归一）再算编辑距离/参考字数 = 逐句字错率；归一化规则与脚本写入报告，T7 复用同一脚本；汇总加权平均 CER、完全正确句数、句均耗时、最长句耗时
- [ ] 步骤 4：写 `T3-baseline.md`（转写脚本与命令一并记录，T7 复用同一脚本保证可比）

---

### Task 4：v2ProPlus 训练（Windows）

**Deps：** `T2`（消费 `logs/elysia` 数据集与 `.list`）

**WritePaths：** 仓库无写入；远端写 `D:\GPT-SoVITS\GPT-SoVITS\GPT_weights\`、`SoVITS_weights*\`（ckpt）与 `D:\datasets\elysia\reports\T4-train-v2pp.md`

**Resources：** **5090 D GPU 独占（与 T5 互斥，串行调度）**；启动前 `nvidia-smi` 余量 ≥16G；vLLM 须处 stopped

**Files：**
- Create：GPT ckpt（`GPT_weights/` 下）、SoVITS ckpt（v2ProPlus 对应 weights 目录）、`T4-train-v2pp.md`

**接口契约：**
- Consumes：T2 数据集；底模 `s1v3.ckpt` + `s2Gv2ProPlus.pth`/`s2Dv2ProPlus.pth`（已就位）
- Produces：一对可用 ckpt（路径+文件名写入报告，供 T6 拷贝）

**终态关联：** `F2`（半边）

**验收标准：**
- [ ] 步骤 1：核对——环境激活入口 `D:\GPT-SoVITS\activate_gptsovits.cmd`；pip 操作带 `PIP_CONFIG_FILE=nul`（全局 pip.ini 有不可达 ngc 索引）；GPU 余量检查
- [ ] 步骤 2：GPT(s1) 训练——官方 webui/CLI，底模 s1v3，epoch 15 起步（允许按 loss 收敛 ±5），后台 + 日志
- [ ] 步骤 3：SoVITS(s2) 训练——v2ProPlus 分支，e12 起步（±4），后台 + 日志；日志无 NaN/中断
- [ ] 步骤 4：冒烟——命令行加载双 ckpt 合成附录 A 第 1 句，wav >50KB 且可解析
- [ ] 步骤 5：写 `T4-train-v2pp.md`：实际 epoch/step/batch、loss 末值、ckpt 路径、冒烟结果、训练耗时
- [ ] 调参预案（T7 判据未达标时用）：epoch 上调至 20-25；更换/加长参考段后重跑 1b/1c；按 QA 报告再筛弱标注条目重训；逐项记录尝试与结果

---

### Task 5：v4 训练（Windows）

**Deps：** `T2`（同 T4）

**WritePaths：** 仓库无写入；远端写 `GPT_weights\`、v4 对应 `SoVITS_weights_v4\` 与 `D:\datasets\elysia\reports\T5-train-v4.md`

**Resources：** **5090 D GPU 独占（与 T4 互斥，串行调度）**；其余同 T4

**Files：**
- Create：GPT ckpt、v4 SoVITS ckpt（含 vocoder 引用，v4 不训 s2D）、`T5-train-v4.md`

**接口契约：**
- Consumes：T2 数据集；底模 `s1v3.ckpt` + `gsv-v4-pretrained/s2Gv4.pth` + `vocoder.pth`
- Produces：v4 一对 ckpt（路径写入报告，供 T6）

**终态关联：** `F2`（另半边）

**验收标准：**
- [ ] 步骤 1：核对——`D:\GPT-SoVITS\activate_gptsovits.cmd` 激活环境；pip 操作带 `PIP_CONFIG_FILE=nul` + TUNA；`nvidia-smi` 余量 ≥16G（SD WebUI 常驻 ~3.9G）；确认与 v2ProPlus 训练不并发（GPU 互斥串行）
- [ ] 步骤 2：GPT(s1) 训练——底模 `s1v3.ckpt`，epoch 15 起步（按 loss 收敛 ±5），后台 + 日志，产出 `GPT_weights\` 下 ckpt
- [ ] 步骤 3：v4 SoVITS 训练——**只训 s2G**（v4 无 s2D），底模 `gsv-v4-pretrained/s2Gv4.pth` + 同目录 `vocoder.pth`（按 webui v4 分支自动携带），epoch 12 起步（±4），输出 `SoVITS_weights_v4\`；日志无 NaN/中断
- [ ] 步骤 4：冒烟——命令行加载双 ckpt 合成附录 A 第 1 句「哈哈哈这个也太离谱了吧」，wav >50KB 且可解析
- [ ] 步骤 5：写 `T5-train-v4.md`：实际 epoch/step/batch、loss 末值、ckpt 路径、冒烟结果、训练耗时
- [ ] 调参预案（T7 判据未达标时用）：epoch 上调至 20-25；更换/加长参考段后重跑 1b/1c；按 QA 报告再筛弱标注条目重训；逐项记录尝试与结果

---

### Task 6：macmini 试听实例部署（9883/9884）

**Deps：** `T4`、`T5`（消费各自 ckpt 路径）

**WritePaths：** 仓库无写入；远端写 macmini `~/tts/GPT-SoVITS/{GPT_weights,SoVITS_weights*}/`（新 ckpt）、`~/Library/LaunchAgents/com.yugang.tts.elysia{2,4}.plist`、`~/tts/audition/elysia-ab/{9883,9884}/`

**Resources：** macmini；新增两个 python 常驻进程（内存余量充足，v4 实测可跑）

**Files：**
- Create：两份新 plist、新 ckpt、日志 `~/tts/elysia2.log`、`~/tts/elysia4.log`

**接口契约：**
- Consumes：T4/T5 的 ckpt 路径；现役 plist 作为模板（只读复制）
- Produces：9883（v2ProPlus）/9884（v4）两个可用服务端点 + 健康状态，供 T7

**终态关联：** `F3`、`F6`

**验收标准：**
- [ ] 步骤 1：ckpt 传输——Windows→本地→macmini（`put-lan` LAN 腿优先；ckpt 合计 <1G）
- [ ] 步骤 2：plist 复制现有 `com.yugang.tts` 模板，改 `-s/-g`（新 ckpt）、`-p`（9883/9884）、`-dr/-dt/-dl` 沿用现役参考音频（`reference/感动-欸嘿，大家笑一笑，好吗？.wav`，保持与基线可比）；`-d mps`
- [ ] 步骤 3：`launchctl load` 前记录 9880-9882 进程/端口快照；load 后两实例 LISTEN、各 curl 3 句合成 200 且 >50KB
- [ ] 步骤 4：核对 9880-9882 快照无变化（F6 半边）
- [ ] 步骤 5：写 `D:\datasets\elysia\reports\T6-deploy.md`：plist 全参、ckpt 落点、健康检查记录

---

### Task 7：AB 对比与用户决策（三实例 × 16 句）

**Deps：** `T3`（基线与脚本）、`T6`（9883/9884）

**WritePaths：** 仓库无写入；远端写 macmini 样本目录、`D:\datasets\elysia\reports\T7-ab.md`

**Resources：** macmini 三实例并发调用（串行逐句即可）；Windows FunASR

**Files：**
- Create：`~/tts/audition/elysia-ab/{9883,9884}/` 样本 ×32、`T7-ab.md`

**接口契约：**
- Consumes：附录 A 句集、T3 的评测脚本与基线表、T6 的端点
- Produces：三实例对比表 + 用户决策记录（胜者端口；是否换参考音频），T8 的执行依据

**终态关联：** `F4`

**验收标准：**
- [ ] 步骤 1：9883/9884 逐句合成附录 A 16 句（与 T3 完全同参数同命名规范）
- [ ] 步骤 2：Windows 复用 T3 脚本转写 + 算 CER/耗时，合并三实例总表
- [ ] 步骤 3：判据核对——至少一个新版本 CER 相对基线降 ≥30%、最长句 ≤90s；不达标的版本在报告标注（触发未满足循环或调参预案）
- [ ] 步骤 4：报告 `T7-ab.md`；**样本交付（用户指定 2026-11-01）：经 macmini 上的 NapCat/OneBot 通道把样本以语音消息发到 MASTER_QQ 私聊**——**机械直发，不经过鱼会话**：独立一次性脚本直接调 OneBot `send_private_msg`（text 段作标签 + record 段发语音），不进 conversation/agent loop、不用 say 工具、不入 outbox、不写 transcript（与 `npm run probe` 同性质的运维侧动作）；每条前置文本标签（如「句11 基线v2」「句11 v2ProPlus」「句11 v4」），必含长难句（11/12/13）与专名句（14/15/16），可另附 2-3 句口语；ONEBOT_TOKEN 由脚本从 .env 间接读取，不得打印/外泄，脚本用后保留在 ~/tts/audition/ 下供复用；**用户听完指定胜者**（决策原文记录进报告）后方可进 T8
- [ ] 附加（可选，用户试听时顺带）：用包内另 3 条情绪参考音频（惊喜/难过等）在胜者实例上各合成 2 句，样本入报告供换参考决策

---

### Task 8：切换上线与超时调整（含仓库改动）

**Deps：** `T7`（消费胜者决策）

**WritePaths：** 仓库 `src/tts.ts`、`src/index.ts`、`AGENTS.md`；远端 macmini `~/yugang/fish.config.json`

**Resources：** 本地开发机（npm test + deploy）；macmini

**Files：**
- Modify：`src/tts.ts`（合成超时默认值 + `TtsConfig` 注释）、`src/index.ts`（`toolTimeoutOverrides` 加 `say` 条目）、`AGENTS.md`（语音节端口清单、§15 超时描述、「已知欠账」姬子条改写）、macmini `fish.config.json`（仅 `voices.爱莉希雅` 切换；先按现场 `*.bak-*` 惯例备份）

**接口契约：**
- Consumes：T7 胜者决策与实测耗时
- Produces：上线后的现役语音链路 + 回滚说明

**终态关联：** `F5`、`F6`

**验收标准：**
- [ ] 步骤 1：定参——合成超时 = 胜者实例实测最长句耗时 ×2.5，向上取整到 10s，上限 120s（覆盖空响应重试一次的最坏情况）
- [ ] 步骤 2：改代码（本地仓库）：① `src/tts.ts` 超时默认值改为新值，并同步 `TtsConfig` 处「默认 25 秒（工具层上限 30 秒…）」注释；② `src/index.ts` 的 `toolTimeoutOverrides` 增加 `say: <合成超时+30>`（全局 `toolTimeoutSeconds` 保持 30，不给其它工具放水；既有 `video:90`/`gpt_image:210` 条目不动）；③ `AGENTS.md` 三处同步——语音节实例/端口清单（切换后实际端口）、§15 超时描述（补 per-tool override 说明）、「已知欠账」姬子/凯尔希合并条改写为「姬子音色：权重已下载校验（`~/tts/models/`），未常驻、未配 voices」（凯尔希半条已还清删除）
- [ ] 步骤 3：本地 `npm test` 全绿；**向用户请求 commit+push 授权**：获准 → 按 `git-commit-convention` 提交推送；被拒 → 记录阻塞上报（voices 切换可先行，但胜者为 v4 时长句必超时失败，等用户决策），**不得在未推送新代码时执行步骤 4**
- [ ] 步骤 4：`fish.sh deploy`（本地开发机跑，后台异步 + 完成后读日志确认横幅）——此时 voices 仍指 9880，鱼以新代码+旧模型运行；deploy 后远程核对 macmini `~/yugang/src/tts.ts` 超时默认值为新值
- [ ] 步骤 5：macmini `fish.config.json`（已备份）：仅切 `voices.爱莉希雅` 至胜者端口（voices 为 mtime 热加载，改完即生效；`toolTimeoutSeconds` 不动）；**9880 plist/权重/参考音频原样不动**
- [ ] 步骤 6：上线验证——切换时间点之后胜者实例日志出现 ≥1 次 **POST** 200（GET 不计）：由用户在群里触发一轮语音（语音提示轮或 @鱼 要求语音回复）；失败则回滚（voices 指回 9880，还原步骤 5 备份）并记录
- [ ] 步骤 7：写 `T8-switch.md`：改动 diff 摘要、上线证据（POST 200 日志行）、落选实例去留决策（默认保留 7 天供复核，之后 `launchctl unload` + 删 plist，或经用户确认长期保留）、回滚步骤（voices 指回 9880 即回滚）

---

## 附录 A：AB 固定句集（16 句，逐字精确使用）

```text
1.  哈哈哈这个也太离谱了吧
2.  今晚还有谁没睡，出来聊天呀
3.  我看看这是谁来了，原来是你呀
4.  这个梗笑死我了，你们真的有才
5.  好困啊，但是还不想睡
6.  早上好，今天也要元气满满哦
7.  谁又半夜偷吃零食，快老实交代
8.  行吧，那就这么定了
9.  你说这话我可就不困了啊
10. 等我一下，马上就来
11. 今天发生了一件特别有意思的事，我在路上走着走着，忽然看到一只小猫从草丛里钻出来，冲我喵喵叫了两声，像是在跟我要吃的，可惜我身上什么都没带，只好蹲下来陪它玩了一会儿。
12. 说起来，距离我们上次这样安安静静地聊天，好像已经过去很久了，大家各自忙着各自的生活，偶尔能在群里冒个泡，说说近况，就已经是很难得的事了。
13. 群里现在还有 3 个人在线吗？那我把这个故事讲完再睡，反正明天是周末，不用早起。
14. 逐火十三英桀的席位，永远留给最璀璨的人
15. 往世乐土的黄金庭院，你什么时候再回来看看呀
16. 人之律者爱莉希雅，向各位问好
```

设计意图：1-10 群聊口语（鱼的日常语域，现模型错字高发区）；11-13 长句/数字（切句与超时压力测试）；14-16 游戏专名与多音字（g2p 高危区）。

## 附录 B：关键事实与路径速查

- Windows：`D:\GPT-SoVITS\GPT-SoVITS`（repo @04a44eb）；env 激活 `D:\GPT-SoVITS\activate_gptsovits.cmd`；pip 需 `PIP_CONFIG_FILE=nul` + TUNA；GPU RTX 5090 D 32G（sm_120，SD WebUI 常驻 ~3.9G）；数据 `D:\datasets\elysia\`；报告目录 `D:\datasets\elysia\reports\`
- 底模（已就位）：公共 hubert/roberta；GPT `s1v3.ckpt`；v2ProPlus `s2G/s2D v2ProPlus`；v4 `gsv-v4-pretrained/s2Gv4.pth` + `vocoder.pth`（v4 不训 s2D）
- macmini：`~/tts/GPT-SoVITS`；现役 9880 爱莉(v2)/9881 桑多涅(v2ProPlus)/9882 凯尔希(v4)，plist 标签 `com.yugang.tts[.sandrone|.kaltsit]`；`-d mps`；fish 仓库 `~/yugang`；`fish.config.json` mtime 热加载；`voices` 无兜底
- 现役基线事实：v2 模型 `【GPT2.0】Elysia`（e20/s10900），症状吐字不清+错字错音（感情正常）；参考音频 4.26s 感动条；`tts.ts` 只传 5 个基础参数，超时 25s，空响应重试一次（auto 语种）
- v4 macmini 推理实测：短句 8.3s 出 2.88s 音频（200/276KB）；v2 同句 1.96s——用户已接受 v4 延迟并授权调超时
- 语料（**已解压盘点确认**，报告：`.pi/subagents/artifacts/53dc3183-a2bb-4262-96c2-2759223d4d8e_executor_output.md`）：macmini `~/tts/datasets/elysia/语音/`（2200 文件/6.1GB，GBK 文件名已正确还原）；`1未处理` 261（2.57GB，不传输）、`2切片后` 749 wav + 7 pkf（1.77GB）、`3处理后`(UVR5) **1183 wav / 1.79GB / 3.03h**（平铺 `1_N.wav` ASCII 名，5-30s、mean 9.22s、2ch 44.1kHz Int16）；HF 对照语料爱莉 1,669 句（OCR+VLM 生成，自带误差）
- 传输铁律：macmini→本地大文件一律 `connect.sh get-lan`（LAN 直连免费，2026-11-01 新增并实测）；中继 `get` 计费，动用前必须先向用户确认
- 代码事实（T8 依赖）：`src/index.ts` 的 `toolTimeoutOverrides` 现值 `{video:90, gpt_image:210}`（per-tool 覆盖）；`toolTimeoutSeconds` **非热加载**（启动时求值，重启鱼才生效）；**voices 才是 mtime 热加载**；`fish.config.json` 的 voices 条目只有 `url/referWav/referText/referLanguage` 四字段，无 timeout 字段
- 评测口径：FunASR 转写 + 逐句编辑距离/参考字数；同一脚本跨 T3/T7 复用
