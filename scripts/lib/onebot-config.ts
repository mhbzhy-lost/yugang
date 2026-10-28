/**
 * 把 .env 里的 WS 设置写进 NapCat 的 onebot.json。
 * protocol.ts 和 token.ts 都用这一份，避免两处配置漂移。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface OneBotConfigInput {
  dir: string;
  port: number;
  token: string;
}

export function writeOneBotConfig({ dir, port, token }: OneBotConfigInput): string {
  const file = join(dir, "config", "onebot.json");
  mkdirSync(join(dir, "config"), { recursive: true });
  const config = {
    network: {
      websocketServers: [
        {
          name: "yugang",
          enable: true,
          host: "127.0.0.1",
          port,
          messagePostFormat: "array",
          token,
          reportSelfMessage: false,
          heartInterval: 30000,
          debug: false,
          enableForcePushEvent: false,
        },
      ],
    },
    musicSignUrl: "",
    enableLocalFile2Url: false,
    parseMultMsg: true,
  };
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}
