---
name: draw
description: 本地 Stable Diffusion 画图/改图，快且免费；出图后必须立刻发出。
---

用本地显卡画一张图发出去：快、免费，但机器关机或排队超时会失败。

画法两种：
- 从零画：不填 ref，按 prompt 画；ratio 选横图/方图/竖图，默认 3:4。
- 改图：填 ref，整张图按 prompt 重画。ref 只认本轮消息里的 inbound/… 和自己画过的
  gen/…；改图沿用参考图比例，ratio 不生效。

看不到图的内容就别猜原图长什么样。失败时把错误告诉用户、可以改描述重试，
不要换别的工具、也不要假装画好了。用户点名云端/在线画图时不在此处。

## 先定角色，再写画面

要画作品里的角色时，先查 tags（不传关键词会拿到平铺总表），把返回的 key 填进
character；双人填 characters[].character。本工具不列角色清单，也不要自己拼 key。

- 词表里有这个角色：把 key 填进 character，LoRA 和角色外观由工具注入。prompt 只写动作、
  表情、构图、场景和服装，不要再写发色、瞳色、耳朵、头饰这些官方特征，也不要写角色
  tag——LoRA 已经带了，重复写反而干扰。
- 词表里没有的角色：可以把角色 tag 写进 prompt（先查 tags 拿准确写法和热度），外貌细节
  写清楚，并告诉用户没有这个角色的专属 LoRA，画的是接近的样子。
- 没点名具体角色：画面里的人就是普通人，外貌在 prompt 里写清楚。

官方服装不会自动注入。想要某套衣服，查该角色的条目，把服装段抄进 prompt；想随便穿就不抄。

## 画面与风格

prompt 写画面本身，用 danbooru tag 为主；普通 tag（cat_ears 之类）查 tags 词表拿准写法和热度。
用户明确说「自定义画图」时 prompt 传空字符串（其余参数照常），不要自己往里补词——
画面内容由角色词表注入与模板机械前缀承担。
负向词是内置的，别写「不要出现什么」。

style=<风格 key> 挂全局画风 LoRA，不改 prompt，可与 character、ref 组合；
风格与角色 LoRA 权重都由词表逐条预设（角色缺省 0.8），模型不可调；要调改词表文件。

风格四轴已机械内置在模板质量前缀（场景级，单人双人同吃，不用写也不要自己手写这套词）：
clean lineart, thin lines / cel shading, hard-edged shadows, painterly shading, visible brushstrokes,
multi-tone shading / cinematic lighting, directional light, strong rim light, dramatic shadows, dappled sunlight。
机械集不含 blush，需要时按人自己在 description 加。负向轴同样机械内置在模板（封锁 photorealistic /
油腻皮肤 / 喷枪渐变），不要写「不要什么」。
四轴没有开关；用户明确要其它特定画风时自己在 prompt 写风格词与四轴共存，或查风格 LoRA 词表有没有对应条目；
参考实测反例：soft gradient、soft volumetric lighting、light rays、
light particles 会把整图压成 pastel 洗白；detailed skin shading、subtle shadow 单独用出喷枪渐变皮肤
（欧美油腻感）。

用户明确要「高清大图 / 超级清楚 / 分辨率大点 / 当壁纸」时传 hd: true（3 倍放大，
明显更慢）；平时不传，默认 2 倍。单人和双人通用。

## 双人

双人同框必须传 characters，恰好两项，一律走区域隔离管线（模型不用管管线细节，
也永远别向用户描述走没走「双人管线」之类的内部概念）。每项写 description：挂了角色的只写动作、表情、
服装；普通人写清外貌。互动自由写在任一人的 description 或 prompt 里。prompt 只写场景和
全局氛围，人数不用写。命名角色默认挂角色 LoRA（characters[].character）；仅当用户明确说
「不挂 LoRA / 用 tag 直出」时才省 character 键、自己在 description 写外观特征。
双人不支持顶层 character、style、ref；hd 可用。

每项可选 region（归一化矩形，x/y 为盒中心）：**区域 ≈ 这个人的画面份额**，直接决定
人物大小与位置——想画全景渺小人物就声明小盒，想画特写就声明大盒，别指望 wide angle
之类的文字能缩小人物（区域引导比文字强）。常用配方（可按画面微调）：
- 全身并排：两盒 x≈0.3/0.7、y≈0.55、w≈0.3、h≈0.85
- 坐着对话（半身）：x≈0.3/0.7、y≈0.45、w≈0.35、h≈0.6
- 全景渺小人物：x≈0.35/0.65、y≈0.75、w≈0.12、h≈0.25
- 两人贴身的构图（拥抱/并肩）：盒子也各自独立、只轻度相邻，别大幅重叠（重叠区会触发复制头/肢体错位）；亲密感写进两人的 description
不填 region 走默认分区（人物会偏大）。写景别词（全景/特写）时记得配相应大小的 region。

hand_repair 只对单人有效，默认关；用户明确要修手才传 true。双人固定不修手。

拿到 gen/ 引用后必须立刻把图发出去，只画不发等于白干。
一轮最多画一次；确认提交失败不消耗次数，提交状态不明时本轮不能重试。
