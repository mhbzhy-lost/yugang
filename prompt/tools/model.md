---
params:
  action: list 看当前角色和可用模型；switch 切换某个角色的模型
  role: switch 必填：main 主对话 / vision 看图看视频 / image 在线画图
  provider: switch 必填：config/models.json 里 providers 的名字
  model: switch 必填：该 provider 下的模型 id；image 可写任意图片模型名
---

查看和切换你自己各类能力使用的模型。

只在主人明确要求换模型时用；`list` 可以随时看。切换只改 `config/models.json` 的
`models` 角色表，写完要 `restart` 才生效。provider 与 model 必须来自 `list` 的结果，
别自己拼一个不存在的名字。image 是图片通道，模型名不校验。
