/** QQ 视频的宿主登记簿：协议来源与会话已见索引持久化，读取权限按轮固定。 */
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { downloadQqVideo } from "./video-download.ts";

export interface VideoAttachment { ref: string; name: string }
export interface QqVideoSource {
  kind: "video" | "file";
  fileId: string;
  busid?: number;
  name: string;
  size?: number;
  url?: string;
}
interface Registration extends QqVideoSource {
  version: 1;
  ref: string;
  chatKey: string;
  registeredAt: number;
  expiresAt: number;
}
interface SeenIndex { version: 1; conversationId: string; chatKey: string; refs: string[] }
const TTL = 24 * 60 * 60_000;
const CAP = 200;
const REF = /^qqvideo:([a-f0-9-]{36})$/;
export const QQ_VIDEO_MAX_BYTES = 100 * 1024 * 1024;
export const isVideoName = (name: string): boolean => /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(name);

export class InboundVideoStore {
  readonly root: string;
  #rounds = new Map<string, { conversationId: string; chatKey: string; refs: ReadonlySet<string> }>();
  constructor(mediaRoot: string) { this.root = resolve(mediaRoot, "inbound-video"); }

  #group(chatKey: string): string {
    if (!/^qq:group:\d+$/.test(chatKey)) throw new Error("video_source_invalid");
    return chatKey.slice(9);
  }
  #path(chatKey: string, name: string): string {
    const path = join(this.root, this.#group(chatKey), name);
    // 每层均拒绝符号链接；注册目录不会成为通用文件读取入口。
    for (const p of [this.root, join(this.root, this.#group(chatKey)), path]) {
      if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error("video_source_invalid");
    }
    return path;
  }
  #read<T>(chatKey: string, name: string): T | undefined {
    try {
      const path = this.#path(chatKey, name);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > 128 * 1024) return;
      if (!realpathSync(path).startsWith(realpathSync(this.root) + sep)) return;
      return JSON.parse(readFileSync(path, "utf8"));
    } catch { return; }
  }
  #write(chatKey: string, name: string, value: unknown): void {
    const path = this.#path(chatKey, name);
    mkdirSync(join(this.root, this.#group(chatKey)), { recursive: true, mode: 0o700 });
    this.#path(chatKey, name);
    const tmp = `${path}.${randomUUID()}.tmp`;
    try { writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: "wx" }); renameSync(tmp, path); }
    finally { rmSync(tmp, { force: true }); }
  }
  resolve(chatKey: string, ref: string): Registration | undefined {
    const id = REF.exec(ref)?.[1];
    if (!id) return;
    const r = this.#read<Registration>(chatKey, `${id}.json`);
    if (!r || r.version !== 1 || r.ref !== ref || r.chatKey !== chatKey || !r.fileId
      || !["video", "file"].includes(r.kind) || !Number.isFinite(r.expiresAt) || r.expiresAt <= Date.now()
      || typeof r.name !== "string" || !Number.isFinite(r.registeredAt) || r.expiresAt - r.registeredAt > TTL) return;
    return r;
  }
  register(chatKey: string, source: QqVideoSource): VideoAttachment {
    if (!source.fileId || source.fileId.length > 4096) throw new Error("video_source_invalid");
    source = { ...source, name: source.name.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069\[\]]/g, " ").replace(/^.*[\\/]/, "").slice(0, 120) };
    const dir = this.#path(chatKey, "");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const live: Registration[] = [];
    for (const name of readdirSync(dir)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const old = this.resolve(chatKey, `qqvideo:${name.slice(0, -5)}`);
      if (old) live.push(old); else rmSync(this.#path(chatKey, name), { force: true });
    }
    const same = live.find((r) => r.fileId === source.fileId);
    if (same) {
      const updated = { ...same, ...source, registeredAt: same.registeredAt, expiresAt: same.expiresAt };
      this.#write(chatKey, `${same.ref.slice(8)}.json`, updated);
      return { ref: same.ref, name: updated.name };
    }
    for (const r of live.sort((a, b) => b.registeredAt - a.registeredAt).slice(CAP - 1)) {
      rmSync(this.#path(chatKey, `${r.ref.slice(8)}.json`), { force: true });
    }
    const ref = `qqvideo:${randomUUID()}`;
    const now = Date.now();
    const record: Registration = { ...source, version: 1, ref, chatKey, registeredAt: now, expiresAt: now + TTL };
    this.#write(chatKey, `${ref.slice(8)}.json`, record);
    return { ref, name: record.name };
  }
  bind(conversationId: string, round: string, chatKey: string, injected: readonly string[]): void {
    if (!/^\d+$/.test(conversationId)) throw new Error("video_source_invalid");
    const name = `seen-${conversationId}.json`;
    const old = this.#read<SeenIndex>(chatKey, name);
    const previous = old?.version === 1 && old.conversationId === conversationId && old.chatKey === chatKey && Array.isArray(old.refs) ? old.refs : [];
    const refs = [...new Set([...previous, ...injected])].filter((ref) => typeof ref === "string" && this.resolve(chatKey, ref)).slice(-CAP);
    if (injected.length > 0) this.#write(chatKey, name, { version: 1, conversationId, chatKey, refs });
    this.#rounds.set(round, { conversationId, chatKey, refs: new Set(refs) });
  }
  clear(round: string): void { this.#rounds.delete(round); }
  async download(conversationId: string, round: string, ref: string, directory: string,
    refresh: (source: QqVideoSource, groupId: number, signal?: AbortSignal) => Promise<string>, signal?: AbortSignal): Promise<{ file: string; name: string }> {
    signal?.throwIfAborted();
    const scope = this.#rounds.get(round);
    if (!scope || scope.conversationId !== conversationId || !scope.refs.has(ref)) throw new Error("video_ref_denied");
    const source = this.resolve(scope.chatKey, ref);
    if (!source) throw new Error("video_ref_expired");
    if (source.size && source.size > QQ_VIDEO_MAX_BYTES) throw new Error("video_too_large");
    const url = await refresh(source, Number(this.#group(scope.chatKey)), signal);
    signal?.throwIfAborted();
    const file = join(directory, "source.video");
    await downloadQqVideo(url, file, QQ_VIDEO_MAX_BYTES, signal);
    signal?.throwIfAborted();
    return { file, name: source.name };
  }
}
