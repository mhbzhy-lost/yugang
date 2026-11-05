/**
 * 人格 → 音色的路由（纯函数，不碰 env、不碰网络）。
 *
 * 这里的规则只有一条：**音色只认 fish.config 的 voices[人格名]**，没有兜底。
 *
 * 为什么专门抽出来：线上出过一次「长征机用爱莉希雅的声音说话」——
 * 早先允许「默认人格用 .env 的 TTS_URL 兜底」，而重启后会话映射键丢了 #人格 后缀，
 * 于是长征机被当成默认人格，直接拿到了默认音色。串音比没有语音糟得多，
 * 所以现在没配置就是没有语音能力。
 */

export const DEFAULT_PERSONA_NAME = "默认";

/** 映射键（chatKey 或 chatKey#人格）→ 人格名。没有 # 后缀就是默认人格。 */
export function personaOf(chatKey: string): string {
  const at = chatKey.lastIndexOf("#");
  return at > 0 ? chatKey.slice(at + 1) : DEFAULT_PERSONA_NAME;
}

/** 从 voices 表里挑出这个会话该用的音色；没配就是 undefined。 */
export function pickVoice<T>(voices: Record<string, T>, chatKey: string): T | undefined {
  return voices[personaOf(chatKey)];
}
