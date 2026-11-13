/**
 * QQ 侧的模型输入渲染门面（2026-11-13 通道适配器 T2）：实现已上收到通道无关的
 * src/channels/render.ts（compact / 新闻播报等宿主共用同一份渲染），本文件保留
 * QQ 包内的相对引用面（onebot / round-input / round-images 从这里取，
 * 现有 import 只改目录前缀、不改符号）。
 */
export * from "../render.ts";
