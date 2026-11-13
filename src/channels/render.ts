/**
 * 通道无关的消息行与列表渲染（从 src/qq/model-input.ts 抽出的共享部分）。
 *
 * T1 阶段先从 `../qq/model-input.ts` 转发导出，现有 import 一律不动（行为零变化）；
 * T2 迁移时内容反转：实现搬进本文件，QQ 专属部分留在 `src/channels/qq/model-input.ts`。
 * `src/compact.ts` 与 `src/external/news-broadcast.ts` 改从本文件取渲染（T2）。
 */
export {
  MESSAGE_LIST_START,
  MESSAGE_LIST_END,
  mentionTargetsOf,
  imageTagOf,
  imageCompressedTagOf,
  gifCompressedTagOf,
  gifTagOf,
  renderMessageLine,
  renderMessageList,
  renderQuotedOriginal,
  renderForwardAttachment,
} from "../qq/model-input.ts";
export type {
  MessageTable,
  MessageBlockParts,
  ForwardChildMessage,
  ForwardAttachment,
  QuotedMessage,
  ModelMessage,
} from "../qq/model-input.ts";
