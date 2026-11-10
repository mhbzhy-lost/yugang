/**
 * hd / 管线阶段级 bisect 的图导出器 —— 只读诊断，不连 ComfyUI、不提交。
 *
 * 用途：把生产 makeGraph / makeRsGraph 构造的图（带 SHA-256 模板校验）原样导出，
 * 并在 43 / 92 / 8 / 最终 四处挂 PreviewImage 抽头，交给 Windows 侧运行器
 * （hd-bisect-run.py）提交与测量。图一律从生产代码导出，不手抄节点。
 *
 * 背景（2026-11-10 hd 发糊根因）：二次采样 node 14 在 3x latent（38,988 token ≈
 * 官方 3:4 档 6 倍）上跑 denoise 0.3 时 DiT 位置编码超域，同分辨率高频能量被砍到
 * ×0.55、脸部 ×0.40，线稿断成虚线；2x 域（17,328 token）只温和损失 ×0.78。
 * 抽头把损伤定位到具体节点：992（放大后）→ 98（二次采样后）→ 9（最终）。
 *
 * 用法：
 *   node scripts/experiments/hd-bisect.ts <outdir> dry            # 导出单人 2x/3x 带抽头的图
 *   node scripts/experiments/hd-bisect.ts <outdir> dry-multi      # 导出双人 2x/3x 带抽头的图
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeGraph, makeRsGraph } from "../../src/tools/draw/comfy.ts";

const SEED = 20261110;
const WIDTH = 912;
const HEIGHT = 1216;
// 上半身正面人像：脸落在可预测的上中部，便于固定同一相对区域做跨阶段对比。
const PROMPT = "1girl, solo, upper body, portrait, looking at viewer, detailed face, detailed eyes, long hair, plain background, soft lighting";
const MULTI_LEFT = "blue hair, very long wavy hair, blue eyes, maid headdress, blue ribbon, blue and white maid dress";
const MULTI_RIGHT = "orange hair, very long wavy hair, orange eyes, hair flower, black bow, white dress";
const MULTI_SCENE = "2girls, standing close together, holding hands, looking at each other, smiling, garden, sunlight, full body";

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

/**
 * 抽头：src = 要观测的生产节点，preview = history 里真正带 images 的 PreviewImage 节点。
 * final 直接用生产已有的输出 PreviewImage（单人 node 9、双人 node 66），其余为新增纯观测节点。
 */
const SINGLE_TAPS = [
  { src: "43", preview: "943", label: "initial", note: "初采样原图 912×1216" },
  { src: "92", preview: "992", label: "upscaled", note: "AnimeSharp 4x + ImageScaleBy 之后，未经二次采样" },
  { src: "8", preview: "98", label: "resampled", note: "VAEEncode → KSampler(0.3) → VAEDecode 之后，未经脸修" },
  { src: "11", preview: "9", label: "final", note: "FaceDetailer 之后（hd 时其后还有纯放大尾部 95/96/97）" },
] as const;
const MULTI_TAPS = [
  { src: "5", preview: "95x", label: "initial", note: "RS 初采样原图" },
  { src: "62", preview: "96x", label: "upscaled", note: "AnimeSharp 4x + ImageScaleBy 之后，未经二次采样" },
  { src: "65", preview: "97x", label: "resampled", note: "二次采样 VAEDecode 之后，未经脸修" },
  { src: "101", preview: "66", label: "final", note: "FaceDetailer 之后（hd 时其后还有纯放大尾部 95/96/97）" },
] as const;

function fail(msg: string): never {
  console.error("ABORT", msg);
  process.exit(1);
}

/** 在已有图上挂纯观测抽头；生产已有的输出 PreviewImage 只校对接线、不重写。 */
function addTaps(graph: Graph, taps: readonly (typeof SINGLE_TAPS)[number][], hd: boolean): Graph {
  for (const tap of taps) {
    if (!graph[tap.src]) fail(`模板缺节点 ${tap.src}`);
    if (graph[tap.preview]) {
      // hd 时输出 PreviewImage 接纯放大尾部（97←96←src），此时校对尾部输入接在 src 上。
      const direct = JSON.stringify(graph[tap.preview].inputs.images) === JSON.stringify([tap.src, 0]);
      const hdTail =
        hd === true &&
        JSON.stringify(graph[tap.preview].inputs.images) === JSON.stringify(["97", 0]) &&
        JSON.stringify(graph["96"]?.inputs?.image) === JSON.stringify([tap.src, 0]);
      if (!direct && !hdTail) fail(`已有节点 ${tap.preview} 不是 ${tap.src} 的 PreviewImage（hd 时也不接 97←96←src）`);
      continue;
    }
    graph[tap.preview] = { class_type: "PreviewImage", inputs: { images: [tap.src, 0] } };
  }
  return graph;
}

function singleGraph(hd: boolean): Graph {
  return addTaps(
    makeGraph({ prompt: PROMPT, width: WIDTH, height: HEIGHT, seed: SEED, cfg: 4.5, handRepair: false, hd }) as unknown as Graph,
    SINGLE_TAPS,
    hd,
  );
}

function multiGraph(hd: boolean): Graph {
  return addTaps(
    makeRsGraph({
      prompt: MULTI_SCENE,
      width: 1280,
      height: 720,
      seed: SEED,
      hd,
      parts: [
        { text: MULTI_LEFT },
        { text: MULTI_RIGHT },
      ],
    }) as unknown as Graph,
    MULTI_TAPS,
    hd,
  );
}

function dump(tag: string, g: Graph, taps: readonly (typeof SINGLE_TAPS)[number][], outdir: string): void {
  const ids = Object.keys(g).sort((a, b) => (Number.isNaN(Number(a)) || Number.isNaN(Number(b)) ? a.localeCompare(b) : Number(a) - Number(b)));
  console.log(`--- ${tag} 节点 ${ids.length} 个：${ids.join(",")}`);
  const scaleNode = g["92"] ?? g["62"];
  console.log(`    首级缩放 scale_by=${(scaleNode.inputs as any).scale_by}   二次采样 steps=${(g["14"] ?? g["64"]).inputs.steps} denoise=${(g["14"] ?? g["64"]).inputs.denoise}`);
  for (const tap of taps) {
    if (!g[tap.preview]) fail(`${tag} 缺抽头节点 ${tap.preview}`);
    if (g[tap.preview].class_type !== "PreviewImage") fail(`${tag} ${tap.preview} 不是 PreviewImage`);
    const src = JSON.stringify((g[tap.preview].inputs as any).images);
    console.log(`    抽头 ${tap.preview} ← ${src}  (${tap.label})`);
  }
  writeFileSync(join(outdir, `${tag}-graph.json`), JSON.stringify(g, null, 2));
}

function main(): void {
  const outdir = process.argv[2];
  const which = process.argv[3] ?? "dry";
  if (!outdir || !["dry", "dry-multi"].includes(which)) fail("用法：hd-bisect.ts <outdir> [dry|dry-multi]");
  mkdirSync(outdir, { recursive: false });
  if (which === "dry") {
    dump("2x", singleGraph(false), SINGLE_TAPS, outdir);
    dump("3x", singleGraph(true), SINGLE_TAPS, outdir);
  } else {
    dump("multi-2x", multiGraph(false), MULTI_TAPS, outdir);
    dump("multi-3x", multiGraph(true), MULTI_TAPS, outdir);
  }
  console.log("DRY OK（未连接 ComfyUI）", outdir);
}

main();
