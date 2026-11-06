/**
 * 鱼缸入口：只做注册，不写逻辑。
 *
 * 顺序就是行为契约（自上而下）：
 *   归一（末条自言/原文/卡片/流水/昵称/chatlog/bypass）
 *   → 主人 `/` 指令（闸前机械通道）
 *   → 规则闸（白名单 / @ / 开窗）
 *   → 群消息：shard 或 10 秒窗口
 *   → 私聊：即时提交
 *
 * （动图自动收的独立阶段已于 2026-11-06 退役：GIF 随 ambient 轮进上下文。）
 *
 * debounce 攒满后的整组提交走 app 的第二入口（onFlush）；生命周期（开窗、新闻、
 * 连 OneBot、恢复、横幅、退出冲刷）走 onStart/onStop。具体实现在 src/app/runtime.ts，
 * 那里按域还能再拆，但不影响入口的可读性。
 */
import { createApp } from "./app/app.ts";
import {
  bootRuntime,
  closeFish,
  closeOnebot,
  commandsStage,
  connectOnebot,
  drainOnStop,
  flushBurst,
  gateStage,
  groupWindowStage,
  installSignals,
  listenMessages,
  normalizeInbound,
  printBanner,
  privateChatStage,
  restoreSessions,
  setFlushSink,
  startEngage,
  startNews,
  stopEngage,
  stopNews,
  type MessageCtx,
} from "./app/runtime.ts";
import type { PendingBurst } from "./qq/debounce.ts";

const app = createApp<MessageCtx, PendingBurst>();

// —— 入站消息链 ——
app.use(normalizeInbound);
app.use(commandsStage);
app.use(gateStage);
app.use(groupWindowStage);
app.use(privateChatStage);

// —— debounce 后的整组提交 ——
app.onFlush(flushBurst);
setFlushSink((burst) => app.flush(burst));

// —— 启动（正序）——
app.onStart(startEngage);
app.onStart(startNews);
app.onStart(listenMessages(app));
app.onStart(connectOnebot);
app.onStart(restoreSessions);
app.onStart(printBanner);

// —— 退出（逆序：停新闻 → 停开窗 → 冲刷 → 断 WS → 关库）——
app.onStop(closeFish);
app.onStop(closeOnebot);
app.onStop(drainOnStop);
app.onStop(stopEngage);
app.onStop(stopNews);

await bootRuntime();
await app.start();

// 信号处理放在启动完成后，与迁移前的注册时点一致（启动中途被 SIGTERM 按默认语义终止）
installSignals(() => app.stop());
