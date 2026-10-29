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
video_invalid: 那不是 B 站视频链接
video_used: 这一轮看过了，先用看到的说
video_failed: 视频没打开：{{url}}
busy_reply: 缸里正在归档记忆，稍等一下再叫我
fs_locked: 这些工具只在主人让你动手改自己时可用
fs_outside: 这个路径不在可操作范围内
fs_missing: 找不到这个文件
fs_binary: 二进制文件不读
fs_too_big: 文件太大
fs_not_found_text: 原文没找到，先 read 看准
fs_ambiguous_text: 原文在文件里出现多次，扩大范围再改
meme_empty: 表情包库是空的，先用文字回
meme_used: 这一轮挑过了，先用挑到的
imggen_prompt: prompt 得有内容，500 字以内
imggen_nokey: 还没配置生图凭据，生不了
imggen_used: 这一轮生过图了，先把图发出去
imggen_failed: 生图没成功：{{detail}}
imggen_done: gen/{{file}} — 生好了，用 say 的 media 参数（gen/ 开头的引用）发出去
draw_prompt: 画面描述得有内容，1000 字以内
draw_used: 这轮画过了，先把画发出去
draw_failed: 画图没成功（Windows 关机或超时？改用别的办法）
draw_done: gen/{{file}} — 画好了，用 say 的 media 参数发出去
tags_empty: 词表还没就绪或关键词为空
tags_none: 词表里没有「{{keyword}}」，换英文关键词试试
draw_off: 本地画图没配置地址，用不了
bypass_placeholder: （一条画图指令：图片的细节发送者已单独指定，直接用 draw 画一张就好）
cmd_personas: 可用人格：{{list}}（用 /切换人格 <名> 切换）
cmd_switched: 切换完成，当前人格：{{persona}}
cmd_bad_persona: 没有这个人格：{{persona}}。{{list}}
cmd_unknown: 不认识的指令：{{cmd}}。可用：/查询可用人格、/切换人格 <名>
