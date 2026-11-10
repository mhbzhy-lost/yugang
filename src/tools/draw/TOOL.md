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
负向词是内置的，别写「不要出现什么」。

style=<风格 key> 挂全局画风 LoRA，不改 prompt，可与 character、ref 组合；
风格权重由词表定，lora_weight 只影响角色 LoRA（0.4–1.1，默认 0.8）。

用户要「更有质感 / 光影更好 / 别太纸片」时，在 prompt 末尾补风格四轴词汇：
- 线稿轴：clean lineart, thin lines
- 阴影轴：cel shading, hard-edged shadows, painterly shading, visible brushstrokes, multi-tone shading, blush
- 光影轴：cinematic lighting, directional light, strong rim light, dramatic shadows, dappled sunlight
负向轴已机械内置在模板（封锁 photorealistic / 油腻皮肤 / 喷枪渐变），不用写也不要写「不要什么」。
实测反例：soft gradient、soft volumetric lighting、light rays、light particles 会把整图
压成 pastel 洗白；detailed skin shading、subtle shadow 单独用出喷枪渐变皮肤（欧美油腻感）。
男性角色或冷调请求可省 blush。用户明确要纯扁平 / chibi 时只留线稿轴，不补阴影轴和光影轴。
双人：线稿轴与阴影轴写进各自 description，光影轴写进 prompt（全局场景）；构图词与风格轴不冲突。

用户明确要「高清大图 / 超级清楚 / 分辨率大点 / 当壁纸」时传 hd: true（3 倍放大，
明显更慢）；平时不传，默认 2 倍。单人和双人通用。

## 双人

双人同框必须传 characters，恰好两项。构图完全由你决定（左右/上下/前后/拥抱重叠都行），
工具不接受任何位置参数：把构图当自然语言写进 description 与 prompt。每项写 description：
挂了角色的只写动作、表情、服装；普通人写清外貌。互动（拥抱/倚靠/趴靠等）自由写在
任一人的 description 或 prompt 里，不需要回避重叠。prompt 只写场景和全局氛围，人数不用写。
命名角色默认挂角色 LoRA（characters[].character）；仅当用户明确说「不挂 LoRA / 用 tag 直出」
时才省 character 键、自己在 description 写外观特征。双人不能用顶层 character、style、ref；
耗时与单人同量级；hd 可用。

hand_repair 只对单人有效，默认关；用户明确要修手才传 true。双人固定不修手。

拿到 gen/ 引用后必须立刻把图发出去，只画不发等于白干。
一轮最多画一次；确认提交失败不消耗次数，提交状态不明时本轮不能重试。
