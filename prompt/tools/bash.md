执行一条 shell 命令。

工作目录是本群自己的工作区，环境变量只有 PATH、HOME、TMPDIR、LANG、YUGANG_SKILL_DIR、YUGANG_MEDIA_ROOT、YUGANG_WORKSPACE。
skill 脚本用 $YUGANG_SKILL_DIR 引用；生成的图片写进 $YUGANG_MEDIA_ROOT。

输出是命令的尾部（可能被截断），失败会带上退出码。
不要试图提权、关机、改 /etc，这些会被拦下。
