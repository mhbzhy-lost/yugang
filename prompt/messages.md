# 工具回给模型的文案。左边是代码，右边是文本。
# 包括 say 的拒绝理由和发送成功回执——模型能看到的所有工具回复都在这里。

say_sent: 已发到群里
empty: 空消息，没什么可说的
too_long: 太长了（{{length}} 字，上限 {{limit}}），压成一句群里的话
too_many_lines: 换行太多，群聊里就是一句话，不要排版
markdown: 不要用 {{what}}
secret: {{what}}
duplicate: 刚说过一样的话，换个说法或者别说
quota_run: 这一轮已经说了 {{count}} 条，够了
quota_minute: 这个群一分钟内说得够多了，先闭嘴
provenance: 这段是从思考或工具结果里抄的（连续 {{overlap}} 字重合），自己重说一遍
media_outside: 图片路径不在媒体目录里
media_missing: 找不到这个图片文件
media_type: 不支持的图片格式：{{ext}}
media_big: 图片太大了（{{size}}MB）
media_magic: 文件头不是图片，拒绝发送
read_outside: 这个路径不在你能读的范围内（只限本群工作目录和媒体目录）：{{path}}
read_missing: 读不到这个文件：{{path}}
draw_done: 画好了，路径：{{path}}
draw_empty: 没说要画什么
draw_too_long: 描述太长了，压成一句话
