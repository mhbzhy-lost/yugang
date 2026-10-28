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
bash_denied: 这条命令被拦下：{{reason}}
deny_root: 不准删根目录
deny_privilege: 这里不需要也不能提权
deny_disk: 不要动磁盘
deny_power: 不要关机
deny_ssh: 不要往外连 ssh
deny_persist: 不要装常驻任务
deny_etc: 不要写 /etc
