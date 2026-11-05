/**
 * 文件版凭据存储：config/auth.json（仓库外、权限 600）就是 pi-ai 的 CredentialStore。
 *
 * 一个 provider 一条凭据：
 *   { "deepseek": { "type": "api_key", "key": "..." } }
 *   { "openai-codex": { "type": "oauth", "refresh": "...", "access": "...", "expires": 1234567890 } }
 *
 * oauth 的刷新由 pi-ai 在请求路径上驱动，刷新结果经 modify() 回写到这里，
 * 所以 token 换了也会落盘，重启后还是有效的。
 *
 * 类型是结构性的本地定义：pi-ai 的 auth 子路径没有对外开放，不在运行时依赖它。
 */
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export type ApiKeyCredential = { type: "api_key"; key?: string; env?: Record<string, string> };
export type OAuthCredential = { type: "oauth"; refresh: string; access: string; expires: number; [key: string]: unknown };
export type Credential = ApiKeyCredential | OAuthCredential;

export interface CredentialStoreLike {
  read(providerId: string): Promise<Credential | undefined>;
  list(): Promise<readonly { providerId: string; type: Credential["type"] }[]>;
  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined>;
  delete(providerId: string): Promise<void>;
}

type Store = Record<string, Credential>;

function load(path: string): Store {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Store;
  } catch {
    return {};
  }
}

function save(path: string, store: Store): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function fileCredentialStore(path: string): CredentialStoreLike {
  return {
    async read(providerId) {
      return load(path)[providerId];
    },
    async list() {
      const store = load(path);
      return Object.entries(store).map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      }));
    },
    async modify(providerId, fn) {
      const store = load(path);
      const next = await fn(store[providerId]);
      if (next === undefined) delete store[providerId];
      else store[providerId] = next;
      save(path, store);
      return next;
    },
    async delete(providerId) {
      const store = load(path);
      delete store[providerId];
      save(path, store);
    },
  };
}
