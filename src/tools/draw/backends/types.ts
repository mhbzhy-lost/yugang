import type { Graph } from "../engine.ts";

export type DrawMode = "single" | "fast" | "ref" | "multi";
export type DrawRatio = "1:1" | "3:4" | "4:3" | "2:3" | "3:2" | "9:16" | "16:9";
export type DrawWorkingVariant = "draw" | "draw_fast" | "draw_interaction";

export interface DrawLoraRef {
  readonly file: string;
  readonly weight: number;
}

export interface DrawRoleInput {
  readonly inject: string;
  /** 当前后端族无匹配 LoRA 时为 undefined（角色自动降级为仅注入外观 tag） */
  readonly lora?: DrawLoraRef;
}

export interface DrawMultiPart {
  readonly text: string;
  readonly role?: DrawRoleInput;
}

export interface DrawCapabilities {
  /** 每个模式是否有对应 workflow：false 时工具层在提交前直接明确拒绝，不做隐式降级 */
  readonly modes: Readonly<Record<DrawMode, boolean>>;
  readonly hd: boolean;
  /** 允许挂全局 style LoRA 的模式列表（如 anima3.8b 为 ["fast", "ref"]） */
  readonly styleModes: readonly DrawMode[];
  readonly framing: boolean;
  readonly spacing: boolean;
}

export interface DrawBuildRequest {
  readonly mode: DrawMode;
  /** 是否开启快速步数档：mode==="fast" 时为 true；mode==="ref" 且用户传了 fast:true 时亦为 true（保 ref+fast 叠加能力） */
  readonly fast: boolean;
  readonly prompt: string;
  readonly width: number;
  readonly height: number;
  readonly hd: boolean;
  readonly seed?: number;
  readonly role?: DrawRoleInput;
  readonly style?: DrawLoraRef;
  readonly parts?: readonly DrawMultiPart[];
  readonly refInputName?: string;
  readonly refStrength?: number;
  readonly framing?: "normal" | "wide";
  readonly spacing?: "together" | "apart";
  readonly bypass?: string;
  readonly pbypass?: string;
}

export interface DrawBuiltGraph {
  readonly graph: Graph;
  readonly outputNode: string;
  readonly outputType: "temp" | "output";
  /** 必须小于 runtime.ts 的 draw 工具外层超时（1800s） */
  readonly deadline: number;
  /** 对应 prompt/messages.md 中的 working_* 提示变体 */
  readonly workingVariant: DrawWorkingVariant;
  /** 可选：触发 onDrawStage("sketch") 的 ComfyUI 节点 ID 集合；未声明时不挂 WS 阶段跟踪 */
  readonly stageNodes?: readonly string[];
}

export interface DrawBackend {
  readonly id: string;
  /** LoRA 兼容族（如 "anima" / "sdxl" / "krea"）；Anima 2B / 2.9B / 3.8B 共享 "anima" 族 */
  readonly loraFamily: string;
  /** 本底模的 7 种比例对应宽高（像素，必须为 8 的倍数） */
  readonly ratioSizes: Readonly<Record<DrawRatio, readonly [number, number]>>;
  readonly capabilities: DrawCapabilities;
  /** 可选：本后端额外自定义加载节点的模型清单映射（class_type → required 字段名数组），与内置默认表合并 */
  readonly extraModelFileFields?: Readonly<Record<string, readonly string[]>>;
  /** 启动期结构契约校验：校验本后端全部 workflow JSON 关键节点在场、类型正确及模型字段覆盖 */
  validateStartup(): void;
  /** 构建本后端的 ComfyUI 图与执行参数 */
  buildGraph(request: DrawBuildRequest): DrawBuiltGraph;
}
