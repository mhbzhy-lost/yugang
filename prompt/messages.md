# 工具回给模型的文案。左边是代码，右边是文本。
# 包括 say 的拒绝理由和发送成功回执——模型能看到的所有工具回复都在这里。

say_sent: 已发到群里
say_once: 这一轮已经说过话了，就此打住
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
too_many_messages: 一次最多说 3 条，拆成几次
react_ok: 贴上了
react_bad: 那不是一个表情编号
react_cooling: 刚贴过，别连着贴
look_outside: 只能看群里的图：{{ref}}
look_missing: 找不到这张图：{{ref}}
look_type: 不是图片：{{ref}}
look_used: 这一轮看过了，先说话
search_query: 关键词得在 1 到 128 字之间
search_nokey: 还没配置搜索凭据，搜不了
search_used: 这一轮搜过了，先用搜到的说话
search_failed: 搜索没成功，换个说法或直接说不知道
