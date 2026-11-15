/**
 * IT bed 确定性 OpenAI Completions 假模型。
 *
 * 只供本地 sandbox 使用，不访问外网、不读取凭据。它根据最后一条用户输入和
 * 当前工具面返回固定 SSE，足够覆盖出口、tool_search、look、news_prepare、
 * 零出口与模型失败路径。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1]! : fallback;
}

const port = Number(arg("port", "4403"));

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((block) => {
    if (!block || typeof block !== "object") return "";
    return typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : "";
  }).filter(Boolean).join(" ");
}

function toolNames(body: Record<string, unknown>): Set<string> {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return new Set(tools.flatMap((tool) => {
    if (!tool || typeof tool !== "object") return [];
    const fn = (tool as { function?: { name?: unknown } }).function;
    return typeof fn?.name === "string" ? [fn.name] : [];
  }));
}

function messagesOf(body: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(body.messages) ? body.messages.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
}

function lastUserText(messages: Record<string, unknown>[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return textOf(messages[i]?.content);
  }
  return "";
}

function calledToolNames(messages: Record<string, unknown>[]): Set<string> {
  const names = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const call of calls) {
      if (!call || typeof call !== "object") continue;
      const fn = (call as { function?: { name?: unknown } }).function;
      if (typeof fn?.name === "string") names.add(fn.name);
    }
  }
  return names;
}

function choose(body: Record<string, unknown>): { tool?: string; args?: Record<string, unknown>; text?: string } {
  const messages = messagesOf(body);
  const userText = lastUserText(messages);
  if (userText.includes("模型故障")) throw new Error("itbed_model_failure");
  if (userText.includes("零出口")) return { text: "我先想想。" };

  const names = toolNames(body);
  const called = calledToolNames(messages);
  // 工具结果会再次触发模型请求；根据此前 assistant tool call 判断是否已经完成，
  // 不要只看结果文本（真实工具回执未必包含工具名），否则 faux 会无限重复调工具。
  if (called.has("say_words") || called.has("news_prepare") || called.has("look")) {
    return { text: "IT bed 已收到。" };
  }
  if (userText.includes("新闻") && names.has("news_prepare")) {
    return {
      tool: "news_prepare",
      args: { sections: [], closing: "IT bed 新闻准备完成" },
    };
  }
  if (userText.includes("看图")) {
    if (called.has("tool_search") && names.has("look")) {
      return { tool: "look", args: { ref: "inbound/itbed.png" } };
    }
    if (names.has("tool_search")) return { tool: "tool_search", args: { query: "看图" } };
    if (names.has("look")) return { tool: "look", args: { ref: "inbound/itbed.png" } };
  }
  if (messages.some((message) => message.role === "tool")) return { text: "IT bed 已收到。" };
  if (names.has("say_words")) return { tool: "say_words", args: { text: `IT bed 已收到：${userText.slice(-80) || "测试消息"}` } };
  return { text: "IT bed 已收到。" };
}

function sse(res: ServerResponse, body: Record<string, unknown>): void {
  const id = `itbed-${Date.now().toString(36)}`;
  const choice = choose(body);
  const model = typeof body.model === "string" ? body.model : "itbed-faux";
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "close",
  });
  if (choice.tool) {
    const args = JSON.stringify(choice.args ?? {});
    const first = {
      id,
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `${id}-call`, type: "function", function: { name: choice.tool, arguments: args } }] }, finish_reason: null }],
    };
    const done = {
      id,
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    };
    res.write(`data: ${JSON.stringify(first)}\n\n`);
    res.write(`data: ${JSON.stringify(done)}\n\n`);
  } else {
    const first = { id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { role: "assistant", content: choice.text ?? "" }, finish_reason: null }] };
    const done = { id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
    res.write(`data: ${JSON.stringify(first)}\n\n`);
    res.write(`data: ${JSON.stringify(done)}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = createServer(async (req, res) => {
  console.log(`[faux-model] ${req.method} ${req.url ?? ""}`);
  if (req.method === "GET" && req.url === "/health") return json(res, 200, { ok: true });
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") return json(res, 404, { error: "not_found" });
  try {
    const body = await bodyOf(req);
    sse(res, body);
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, "127.0.0.1", () => console.log(`[faux-model] listening 127.0.0.1:${port}`));
process.once("SIGTERM", () => server.close(() => process.exit(0)));
process.once("SIGINT", () => server.close(() => process.exit(130)));
