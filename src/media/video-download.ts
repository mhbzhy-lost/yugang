/** QQ CDN 视频下载：每跳校验来源和 DNS，连接固定到已验证的公网地址，流式限量落盘。 */
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
const blocked = new BlockList();
for (const [ip, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3]] as const) blocked.addSubnet(ip, bits, "ipv4");
for (const [ip, bits] of [["::", 96], ["64:ff9b::", 96], ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) blocked.addSubnet(ip, bits, "ipv6");

export async function downloadQqVideo(raw: string, file: string, maxBytes: number, caller?: AbortSignal): Promise<void> {
  const signal = AbortSignal.any([AbortSignal.timeout(60_000), ...(caller ? [caller] : [])]);
  let url = new URL(raw);
  for (let hop = 0; hop <= 3; hop++) {
    signal.throwIfAborted();
    const host = url.hostname.toLowerCase();
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
      || (url.port && url.port !== (url.protocol === "https:" ? "443" : "80"))
      || !["qq.com", "qpic.cn", "gtimg.com"].some((domain) => host === domain || host.endsWith(`.${domain}`))) throw new Error("video_source_invalid");
    const addresses = await lookup(host, { all: true });
    signal.throwIfAborted();
    if (!addresses.length || addresses.some(({ address }) => !isIP(address) || address.toLowerCase().startsWith("::ffff:") || blocked.check(address, isIP(address) === 6 ? "ipv6" : "ipv4"))) throw new Error("video_source_invalid");
    const address = addresses.find((item) => item.family === 4) ?? addresses[0];
    const res = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      // Node 22+ 支持该选项；仓库当前的 http 类型定义尚未透传 net 的此字段。
      const options: import("node:https").RequestOptions & { autoSelectFamily: boolean } = {
        signal, autoSelectFamily: false, family: address.family,
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      };
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, options, resolve);
      request.on("error", reject);
      request.end();
    });
    if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
      res.destroy();
      if (!res.headers.location || hop === 3) throw new Error("video_download_failed");
      url = new URL(res.headers.location, url);
      continue;
    }
    if (res.statusCode !== 200) { res.destroy(); throw new Error("video_download_failed"); }
    if (Number(res.headers["content-length"]) > maxBytes) { res.destroy(); throw new Error("video_too_large"); }
    let total = 0;
    const bound = new Transform({ transform(chunk, _encoding, callback) {
      total += chunk.length;
      callback(total > maxBytes ? new Error("video_too_large") : null, chunk);
    } });
    await pipeline(res, bound, createWriteStream(file, { flags: "wx", mode: 0o600 }), { signal });
    if (!total) throw new Error("video_download_failed");
    return;
  }
  throw new Error("video_download_failed");
}
