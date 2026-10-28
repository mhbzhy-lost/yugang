/**
 * QQ 侧配置验收：连上协议端的 OneBot v11 正向 WebSocket，报一下身份和群，
 * 需要的话顺手发一条测试消息。
 *
 *   ONEBOT_WS_URL=ws://127.0.0.1:3001 ONEBOT_TOKEN=xxx npm run probe
 *   TEST_GROUP=123456 npm run probe          # 额外发一条测试消息
 */
const url = process.env.ONEBOT_WS_URL ?? "ws://127.0.0.1:3001";
const token = process.env.ONEBOT_TOKEN;
const testGroup = process.env.TEST_GROUP;

const ws = new WebSocket(url, token ? ({ headers: { Authorization: `Bearer ${token}` } } as never) : undefined);
let seq = 0;
const pending = new Map<string, (value: unknown) => void>();

function call(action: string, params: Record<string, unknown> = {}): Promise<any> {
  const echo = `p${++seq}`;
  return new Promise((resolve) => {
    pending.set(echo, resolve);
    ws.send(JSON.stringify({ action, params, echo }));
    setTimeout(() => resolve({ timeout: true, action }), 5000).unref?.();
  });
}

ws.addEventListener("open", async () => {
  console.log(`已连接 ${url}${token ? "（带 token）" : "（无 token）"}`);

  const login = await call("get_login_info");
  if (login?.timeout) {
    console.error("✗ get_login_info 超时：协议端没在监听，或者 token 不对");
    process.exit(1);
  }
  console.log(`✓ 登录身份：${login?.data?.nickname} (${login?.data?.user_id})`);

  const groups = await call("get_group_list");
  const list = (groups?.data ?? []) as { group_id: number; group_name: string }[];
  console.log(`✓ 在 ${list.length} 个群里：${list.map((g) => `${g.group_name}(${g.group_id})`).join("、") || "（一个都没有，先把鱼拉进群）"}`);

  if (testGroup) {
    const sent = await call("send_group_msg", {
      group_id: Number(testGroup),
      message: [{ type: "text", data: { text: "鱼缸验收：能看到这条就通了" } }],
    });
    if (sent?.timeout || sent?.retcode) console.error("✗ 发送失败", sent);
    else console.log(`✓ 已向群 ${testGroup} 发出一条测试消息`);
  }

  ws.close();
  process.exit(0);
});

ws.addEventListener("error", () => {
  console.error(`✗ 连不上 ${url}：检查协议端是否启动、端口、token`);
  process.exit(1);
});
