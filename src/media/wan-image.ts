/** 百炼 Token Plan Wan Image 原生多模态生图客户端。 */
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export interface WanImageRequest {
  apiKey: string;
  baseUrl: string;
  model: string;
  prompt: string;
  size?: string;
  mediaRoot: string;
  signal?: AbortSignal;
}

export async function generateWanImage(request: WanImageRequest): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  const signal = request.signal ? AbortSignal.any([controller.signal, request.signal]) : controller.signal;
  try {
    const response = await fetch(`${request.baseUrl.replace(/\/+$/, "")}/api/v1/services/aigc/multimodal-generation/generation`, {
      method: "POST",
      headers: { authorization: `Bearer ${request.apiKey}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        model: request.model,
        input: { messages: [{ role: "user", content: [{ text: request.prompt }] }] },
        ...(request.size ? { parameters: { size: request.size } } : {}),
      }),
      signal,
    });
    if (!response.ok) throw new Error(`wan_image_http_${response.status}`);
    const parsed = await response.json() as { output?: { choices?: Array<{ message?: { content?: Array<{ image?: string }> } }> } };
    const url = parsed.output?.choices?.[0]?.message?.content?.find((item) => typeof item.image === "string")?.image;
    if (!url) throw new Error("wan_image_empty");
    const image = await fetch(url, { signal });
    if (!image.ok) throw new Error(`wan_image_download_${image.status}`);
    const bytes = Buffer.from(await image.arrayBuffer());
    if (bytes.length < 1024) throw new Error("wan_image_too_small");
    const dir = join(request.mediaRoot, "gen");
    mkdirSync(dir, { recursive: true });
    const file = `${Date.now()}-${randomUUID()}.png`;
    writeFileSync(join(dir, file), bytes, { flag: "wx" });
    return file;
  } finally {
    clearTimeout(timeout);
  }
}
