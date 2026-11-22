/** 百炼 Token Plan Wan Image 原生多模态生图客户端。 */
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export interface WanImageRequest {
  apiKey: string;
  baseUrl: string;
  model: string;
  prompt: string;
  size?: "1K" | "2K";
  n?: number;
  enableSequential?: boolean;
  mediaRoot: string;
  signal?: AbortSignal;
}

export async function generateWanImage(request: WanImageRequest): Promise<string[]> {
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
        ...((request.size || request.n !== undefined || request.enableSequential !== undefined) ? {
          parameters: {
            ...(request.size ? { size: request.size } : {}),
            ...(request.n !== undefined ? { n: request.n } : {}),
            ...(request.enableSequential !== undefined ? { enable_sequential: request.enableSequential } : {}),
          },
        } : {}),
      }),
      signal,
    });
    if (!response.ok) throw new Error(`wan_image_http_${response.status}`);
    const parsed = await response.json() as { output?: { choices?: Array<{ message?: { content?: Array<{ image?: string }> } }> } };
    const urls = parsed.output?.choices?.flatMap((choice) => choice.message?.content ?? [])
      .map((item) => item.image).filter((image): image is string => typeof image === "string");
    if (urls.length === 0) throw new Error("wan_image_empty");
    const dir = join(request.mediaRoot, "gen");
    mkdirSync(dir, { recursive: true });
    const files: string[] = [];
    for (const url of urls) {
      const image = await fetch(url, { signal });
      if (!image.ok) throw new Error(`wan_image_download_${image.status}`);
      const bytes = Buffer.from(await image.arrayBuffer());
      if (bytes.length < 1024) throw new Error("wan_image_too_small");
      const file = `${Date.now()}-${randomUUID()}.png`;
      writeFileSync(join(dir, file), bytes, { flag: "wx" });
      files.push(file);
    }
    return files;
  } finally {
    clearTimeout(timeout);
  }
}
