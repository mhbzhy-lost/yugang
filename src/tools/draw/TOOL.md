---
name: draw
description: 本地 Stable Diffusion 画图/改图，快且免费；出图后必须立刻发出。
---

在本地的 Windows 显卡上用 Stable Diffusion 画一张图发出去。这是本地生图通道：
快、免费、带画风预设，但机器关机或排队超时就会失败。

两种画法：
- 从零画：不填 ref，按 prompt 描述直接画；需要指定横图、方图或竖图时可选 ratio，默认竖图 3:4。
- 改图：填 ref，整张图按 prompt 重画。ref 只认这一轮消息里出现过的 inbound/…
  和自己画过的 gen/…，别的路径会被拒。改图沿用参考图比例（尺寸对齐可能略有偏差），ratio 不生效。

看不到图的内容就别猜原图长什么样。

失败时直接把错误告诉用户、可以改描述重试，不要自己换成别的工具、也不要假装画好了。
这里只走本地显卡；用户点名云端/在线画图时不在此处。

prompt 写画面本身：想画得准就先查词表，再拼 prompt。用户提到有官方设定的
角色时，必须先用 tags 查角色名，把官方 tag 和变体 tag（不同皮肤/形态是不同
tag）都查出来再挑最贴切的——例如 Elysia 原始 tag 是
`elysia_(honkai_impact_3rd)`，粉色精灵形态是变体 `elysia_(miss_pink_elf)_(honkai_impact_3rd)`，
两个 tag 出来的人物造型不一样。选定了官方 tag（或其变体）就不要再对人物
外貌画蛇添足：不要再叠加发色、服装、体型这类特征描述，它们会跟 tag 自带的
官方设定打架，出了冲突图怪谁都不好使。词表查不到官方 tag 时，先 search 网络搜该
角色的人设信息（外貌、服饰、特征），再把搜到的要点拼进 prompt，不要凭印象
瞎编角色的样子。负向词表是内置预设，
不接受注入，画面描述里别写「不要出现什么」。单人从零画和整图重绘默认使用
RealESRGAN 2 倍超分并二次采样；双人图使用 AnimeSharp 2 倍超分并低强度细化。
单人图手部修复默认开启；用户明确要求不修时用 hand_repair=false。双人图暂不进行手部修复，hand_repair 对双人图不生效；人脸修复与超分保留。
hsr 预设使用适配 V8 的 HSR LoRA 层映射，效果可能与旧通道不同。
画 AI 娘角色（克劳德、大肥鱼/鲸鱼娘、白龙娘、Gemini 猫耳娘、Grok 吸血鬼大小姐、
Kimi、千问、智谱狐娘这些 AI 拟人角色）时优先传 character 键，不要硬画：触发词、
官方基础外观和头饰会自动注入，同一个角色只描述动作、表情、构图和服装，不要再手动叠
该角色的发色瞳色体型——会跟 LoRA 自带的官方设定打架。想要官方套装就用 tags 工具
查该角色名，把服装段抄进 prompt；想换装就自己写服装。用户说「全套设定/官方服装/完整人设」时，
先查 tags 把上身/下身/脚段都抄进 prompt；用户说「衣服不限/随便穿」时，只传 character 不抄服装段。
角色不够像用 lora_weight
调高，脸崩或污染画面就调低（0.4–1.1，默认 0.8）。character 与 hsr 预设、改图
ref 可以组合使用。
双角色同框：prompt 写场景与全局氛围；characters 写恰好两项，顺序是左、右。
每项的 description 写这个人的动作、表情和服装；普通人物还要描述外貌。AI 娘可在对应项
填写 character，自动注入该角色的 LoRA 和基础外观。两人互动动作可以写在各人的描述或 prompt。
例如：`characters: [{character: "deepseek", description: "sitting sideways, teasing a cat"}, {character: "claude", description: "holding cat food, looking at her"}]`。
双角色不支持 preset 与 ref，耗时也更长（约两分钟），会分阶段播报进度。
两个普通人物使用 RS 按左右区域生成；互动动作可同时写在 prompt 和各人的 description。复杂重叠可能出现人物重复或串色。
含 AI 娘的双人图仍需从构图中可靠区分两人；遮挡严重或分割不明确时可能失败，不会自动把画面切半充当两个人物。
拿到 gen/ 引用后必须立刻把图发出去，只画不发等于白干。
一轮最多画一次；确认提交失败不消耗次数，提交状态不明时本轮不能重试。
