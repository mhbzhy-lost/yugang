/** 轻量兼容门面：重导出共享 ComfyUI 引擎与 anima3.8b 默认构图包装，保既有调用方零破坏。 */
import {
  ComfyBusy,
  ComfyExecutionFailed,
  comfyUrl,
  execGraph,
  runExclusive,
  uploadRefImage,
  type DrawStage,
  type ExecOpts,
  type Graph,
  type Link,
  type Node,
} from "./engine.ts";
import {
  makeGraph,
  makeInteractionGraph,
  makeInteractionSingleGraph,
  type ComfyDraw,
  type InteractionDraw,
  type InteractionPreset,
  type MultiPart,
} from "./backends/anima3.8b/index.ts";

export {
  ComfyBusy,
  ComfyExecutionFailed,
  comfyUrl,
  execGraph,
  makeGraph,
  makeInteractionGraph,
  makeInteractionSingleGraph,
  runExclusive,
  uploadRefImage,
  type ComfyDraw,
  type DrawStage,
  type ExecOpts,
  type Graph,
  type InteractionDraw,
  type InteractionPreset,
  type Link,
  type MultiPart,
  type Node,
};

export async function runComfy(
  url: string,
  args: ComfyDraw,
  onSubmitted: () => void,
  onStage?: (s: DrawStage) => void,
  signal?: AbortSignal,
): Promise<Buffer> {
  return runExclusive(async () => {
    const name = args.ref ? await uploadRefImage(url, args.ref.png, "png", signal) : undefined;
    return await execGraph(url, makeGraph(args, name), {
      deadline: 240_000,
      outputNode: "9",
      outputType: "temp",
      onSubmitted,
      onStage,
      signal,
    });
  });
}

export async function runInteraction(
  url: string,
  args: InteractionDraw,
  onSubmitted: () => void,
  signal?: AbortSignal,
): Promise<Buffer> {
  return runExclusive(async () => {
    return await execGraph(url, makeInteractionGraph(args), {
      deadline: 1_500_000,
      outputNode: "38",
      outputType: "output",
      onSubmitted,
      signal,
    });
  });
}

export async function runInteractionSingle(
  url: string,
  args: Parameters<typeof makeInteractionSingleGraph>[0],
  onSubmitted: () => void,
  signal?: AbortSignal,
): Promise<Buffer> {
  return runExclusive(async () => {
    return await execGraph(url, makeInteractionSingleGraph(args), {
      deadline: 1_500_000,
      outputNode: "38",
      outputType: "output",
      onSubmitted,
      signal,
    });
  });
}
