---
params:
  prompt: 画面描述。写清主体、构图、风格；这是唯一必填项
  model: 模型 id，默认 gpt-image-2；一般不用填
  n: 要几张，默认 1，最大 10。服务端目前只会回 1 张
  size: 尺寸，如 1024x1024 / 1536x1024 / 1024x1536 / auto。服务端目前不一定认，画幅主要看 prompt 里的构图描述
  quality: 画质 auto / low / medium / high；2.5 系列还认 xhigh / max
  background: auto / transparent / opaque；要透明底就传 transparent，配合 png
  output_format: png / jpeg / webp；默认 png
  output_compression: 0-100，仅 jpeg / webp 有意义
  moderation: auto / low；审核强度
  images: 参考图列表，写媒体目录下的路径（如 inbound/xxx.jpg、gen/xxx.png），最多 5 张；传了就是改图，不传是纯文生图
---

用 GPT Image 2 画图或改图。**只有用户明确要求用 GPT / 在线 / 云端生图时才用这个工具**；
没提就老老实实用 draw 走本地显卡，别自己替用户换通道。

参数全部原样交给 OpenAI 那一侧的图片接口，不做加工：你要什么就传什么，传了不生效
就是服务端的事，不要在回复里解释参数、也不要猜哪些生效了。

两条硬规矩：

- 图必须立刻用 say 的 media 发出去，一次一张；n 大于 1 时按返回的列表逐张发
- 画完不要说分辨率、尺寸、画质之类的承诺——那几项服务端不一定认

要改群友发的图，把那张图的引用放进 images（如 inbound/1793...jpg）。mask、seed、
aspect_ratio 这类参数 Codex 后端不支持，别传。
