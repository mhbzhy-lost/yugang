/**
 * installGroup：群/私聊 → 会话（按人格隔离）的创建与复用（2026-11-05 从 harness.ts 拆出）。
 *
 * 映射键：默认人格 = 原键（存量零迁移）；人格 X = 原键#X。会话创建后同时登记
 * memoryKey（人格名）与原始 chatKey（人格名@chatKey 的私有层 key 由它现算）。
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Conversation, Extension, Harness } from "@earendil-works/pi-durable";
import { ChatsDoc } from "../store.ts";
import { renderTemplate } from "../prompt/index.ts";
import { memoryKeyOf } from "../memory/scope.ts";
import type { FishBase } from "./base.ts";
import { GroupProfileEntry } from "./docs.ts";
import { DEFAULT_PERSONA, type GroupProfile } from "./types.ts";

export interface GroupParts {
  group(groupKey: string, profile?: GroupProfile, persona?: string): Promise<Conversation>;
}

function safeName(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]+/g, "_");
}

export function installGroup(
  state: FishBase & { harness: Harness; personaExtensions: Map<string, Extension> },
): GroupParts {
  const { harness, options, prompts, ctx, now, groups, workspaceRoot, personaExtensions } = state;

  function group(groupKey: string, profile?: GroupProfile, persona: string = DEFAULT_PERSONA): Promise<Conversation> {
    let effective = persona;
    if (effective !== DEFAULT_PERSONA && !personaExtensions.has(effective)) {
      // 人格书被删后的悬空名：回退默认人格键，不建空人格会话
      console.warn(`[鱼缸] group(${groupKey}) 人格 ${effective} 未注册，回退默认`);
      effective = DEFAULT_PERSONA;
    }
    // 映射键：默认人格 = 原键（存量零迁移）；人格 X = 原键#X
    const key = effective === DEFAULT_PERSONA ? groupKey : `${groupKey}#${effective}`;
    let existing = groups.get(key);
    if (!existing) {
      existing = (async () => {
        // 先按持久化的映射找回来；找不到才建新的
        const snapshot = await harness.snapshot(ChatsDoc, ctx);
        const known = snapshot?.chats?.[key];
        if (typeof known === "number") {
          const reused = await harness.conversation(known, ctx);
          if (reused) return reused;
        }
        const extension = effective === DEFAULT_PERSONA ? undefined : personaExtensions.get(effective);
        const cwd = join(workspaceRoot, safeName(groupKey) + (extension ? `#${effective}` : ""));
        mkdirSync(cwd, { recursive: true });
        const created = await harness.createConversation(
          {
            ownership: { kind: "ownerless" },
            // 默认人格不传 extensions：跟 host 钉住的默认选择，存量会话行为不变
            agent: {
              model: options.model,
              ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
              cwd,
              ...(extension ? { extensions: [extension] } : {}),
            },
            init: profile
              ? async (tx, conversationId) => {
                  const text = renderTemplate(prompts.groupProfile, {
                    groupId: profile.groupId,
                    count: String(profile.count),
                    master: profile.master,
                    // 首次群档案 system prompt 只放群号/人数/QQ 号：群名、群主、昵称都是外部可变输入，
                    // 实时消息里已有 昵称(QQ) 背景行；master 是本地配置，可信
                    members: profile.members.map((m) => m.userId).join("\n") || "（拿不到名单）",
                  });
                  await tx.appendEntry(GroupProfileEntry, conversationId, {
                    model: [{ role: "system", content: text, timestamp: now() }],
                  });
                }
              : undefined,
          },
          ctx,
        );
        await harness.commit(async (tx) => {
          const chats = await tx.doc(ChatsDoc);
          chats.chats[key] = created.id;
        }, ctx);
        return created;
      })().then((conversation) => {
        // 创建与复用两条路径都在这里登记：key 是映射键（chatKey 或 chatKey#人格），
        // memoryKeyOf 提取人格名（无后缀 = 默认）——同一个人格的所有会话
        // （各群、私聊）都指向同一个公共 family member；原始 chatKey 另存一份，
        // 待审条目的来源会话与私有层 doc key（人格名@chatKey）都由它现算。
        // worker 会话（worker:*）不登记 memory key：后台作业不是聊天，memory section
        // 与 compactor 抽取都靠「无 key 双重 fail-closed」隔离——不注入共享记忆、
        // 不做抽取（compact.ts 无 key 分支）。chatKey 照常登记，用量记账与换页检查不受影响。
        if (!key.startsWith("worker:")) {
          state.memoryKeyByConversation.set(String(conversation.id), memoryKeyOf(key));
        }
        state.chatKeyByConversation.set(String(conversation.id), groupKey);
        return conversation;
      });
      groups.set(key, existing);
    }
    return existing;
  }

  return { group };
}

