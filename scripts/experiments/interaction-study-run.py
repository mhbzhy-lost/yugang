#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""interaction-study-run.py —— Anima 双人交互探索实验的离线 runner（T3b）。

方案：docs/plans/2026-11-11-anima-interaction-study.md §8 / §8.1（T3b）。
契约说明：var/local-driver/anima-interaction-v1/contracts/runner.md（本脚本的唯一配套文档）。
冻结声明式契约：var/local-driver/anima-interaction-v1/spec.json（T1）。
实体/环境事实：var/local-driver/anima-interaction-v1/preflight.json（T0）。

════════════════════════════════════════════════════════════════════════════
本文件是什么 / 不是什么
════════════════════════════════════════════════════════════════════════════
是：一个纯标准库、单文件、两种模式的实验采样调度器骨架——
    · controller 模式：跑在开发 Mac（本仓库所在机器），只经 home-connect 既有
      connect.sh mac 调用生产 Mac 上已上线的 interaction-resource.ts helper `status`，
      **解析 JSON 的 gate.gateIntact（绝不看 exit code）**，据此签发短 TTL 的受控
      提交许可（submit-permit），并可把许可推送 / 拉起 Windows worker。
    · worker 模式：跑在 Windows 隔离实验实例所在机器（embedded python），是**独立
      后台进程**，持久化 manifest/job/prompt_id/state，按新鲜许可一次一个任务地
      POST 到隔离实例、轮询 history、取回原始 PNG 与 generation_info、原子落盘。

不是：不评审兼容/资产（那是 T0）、不构图（那是 T3a）、不产 patch（那是 T4）、
      不恢复鱼权限（那是 G1，另派）、不新建 SSH/隧道/服务、不装依赖、不碰生产
      8188/PID 36932、不碰 fish.db/表情库/QQ、不评分/不选优/不看图。

════════════════════════════════════════════════════════════════════════════
本轮交付状态（T3b 实现轮）
════════════════════════════════════════════════════════════════════════════
仅实现 + 静态检查（py_compile / --help）。**没有**发起任何
真实 relay 调用、没有向任何 ComfyUI（生产或隔离）发过请求、没有拉起任何进程、没有
预分配任何真实任务、没有安装依赖。所有远端/网络/子进程代码路径默认 print-only，
只有显式 `--execute` 才会真跑，而 `--execute` 属于另派的真实冒烟，不在本轮。
真实运行需要的运行时实体（隔离实例 PID/API、客户端 prompt_id 是否被服务端当键、
上传名回显、study_metadata 的 ui 键形态）都作为**待实测协议点**在 runner.md 列清，
脚本对缺值一律明确拒绝，不填假路径/假 hash、不写空 pass/TODO。

════════════════════════════════════════════════════════════════════════════
安全不变式（机械执行，fail-closed）
════════════════════════════════════════════════════════════════════════════
1. 一次一个任务；提交前独立核实隔离队列空闲 + 许可新鲜 + gateIntact。
2. 先持久化 submitting + 预分配 client_id，再 POST；任何网络异常一律不重新 POST，
   任务转 unknown，按 client_id/job_id/prompt 有界回查关联；关联不成即 unresolved
   并停止调度。客户端指定 prompt_id 只有在 `--client-prompt-id-verified`（另派冒烟
   证明服务端确实以其为键）后才启用；缺省不假设回显成立。
3. accepted/unknown 只能用原 prompt_id 恢复（resume/reattach），断线不取消已提交作业。
4. 单任务观察上限 1800s（可配）；超时只记 observation_timeout/unresolved，绝不
   伪装 server 取消/closed，绝不据此恢复鱼。
5. 成功 = history completed/success + 每个 image_node 输出为合法 PNG（魔数+IHDR）+
   尺寸符合 expected_width/height + sha256 落盘；缺一即非成功。
6. history 原 JSON 与 metadata 节点 ui.study_metadata 字符串列表**原文**存
   generation-info/，不从 stdout/进度日志猜审计。
7. state.json 原子写（tmp+os.replace）；results.jsonl 追加；新建 state 不覆盖未知
   旧 run（manifest sha 不符即拒绝，除非显式 --new-run 先归档）。
8. 批预算：--max-new-jobs / --max-wallclock-seconds 至少给一个；到界不再 POST，
   有界回查 accepted 后写精确续接点；不用新 seed 补跑、不自动扩大 808 预算。
9. closure 只有在全部**已提交**任务闭合（无 submitting/accepted/unknown/
   observation_timeout/unresolved）且隔离队列新鲜空闲时才产 jobs-closed.json。
10. 凭据/密钥/生产 COMFYUI_URL 一律不入日志、不入 metadata、不入许可；worker 只认
    隔离 loopback URL，永不 GET 生产 8188，永不读 Mac 凭据/lease。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import socket
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

RUNNER_VERSION = "anima-interaction-v1-t3b-1"
STATE_VERSION = 1
PERMIT_VERSION = 1
MANIFEST_SCHEMA_FIELD = "schema_version"

# 计划 §8 冻结：每任务观察上限 1800s；轮询间隔沿用仓库既有 1.5–3s 习惯。
DEFAULT_JOB_TIMEOUT_S = 1800
DEFAULT_POLL_INTERVAL_S = 3.0
DEFAULT_HTTP_TIMEOUT_S = 30
DEFAULT_VIEW_TIMEOUT_S = 120
DEFAULT_PERMIT_TTL_S = 180
DEFAULT_REFRESH_INTERVAL_S = 60

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

# 终态里「已闭合」（不再占用 GPU、无未决问题）与「未闭合/在途」的划分。
CLOSED_STATES = {"success", "execution_error", "reuse_resolved", "skipped_mechanical"}
OPEN_SUBMITTED_STATES = {"submitting", "accepted", "running", "unknown", "observation_timeout", "unresolved"}
# 停止调度（不再 POST 新任务）的触发态。
STOP_SCHEDULING_STATES = {"unknown", "unresolved", "observation_timeout"}

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_RUNTIME = 3
EXIT_STOP = 4  # 许可过期/隔离队列有外部任务/unknown/observation_timeout → 停止新增提交，需恢复


# ══════════════════════════════════════════════════════════════════════════
# 小工具
# ══════════════════════════════════════════════════════════════════════════
class RunnerError(Exception):
    """带退出码的可预期错误（用法/安全闸/运行时）。"""

    def __init__(self, message: str, code: int = EXIT_RUNTIME) -> None:
        super().__init__(message)
        self.code = code


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        fh.write(text)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def atomic_write_json(path: Path, obj) -> None:
    atomic_write_text(path, json.dumps(obj, ensure_ascii=False, indent=2) + "\n")


def append_jsonl(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(obj, ensure_ascii=False) + "\n")
        fh.flush()
        os.fsync(fh.fileno())


def jload(path: Path):
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def png_dimensions(data: bytes):
    """纯标准库解析 PNG 头：返回 (width, height) 或 None（不是合法 PNG）。"""
    if len(data) < 24 or data[:8] != PNG_MAGIC:
        return None
    # 第一个 chunk 必须是 IHDR：4B 长度 + 4B 'IHDR' + 4B width + 4B height
    if data[12:16] != b"IHDR":
        return None
    w, h = struct.unpack(">II", data[16:24])
    return int(w), int(h)


def safe_output_filename(name) -> bool:
    """history locator 的 filename 必须是安全 basename .png（无路径穿越）。"""
    if not isinstance(name, str) or not name:
        return False
    if name != Path(name).name:  # 含目录分隔
        return False
    if "/" in name or "\\" in name or name.startswith("."):
        return False
    return name.lower().endswith(".png")


def host_label() -> str:
    try:
        return socket.gethostname()
    except Exception:
        return "unknown-host"


def require(value, label: str):
    """显式拒绝缺失的运行时必填实体（不填假值）。"""
    if value is None or (isinstance(value, str) and value.strip() == ""):
        raise RunnerError(f"缺少必填参数 {label}（不接受空值/占位；见 runner.md『必需显式输入』）", EXIT_USAGE)
    return value


# ══════════════════════════════════════════════════════════════════════════
# preflight.json 真实字段提取（T0 已交；缺键即拒，不推断）
# ══════════════════════════════════════════════════════════════════════════
def dig(obj, path: str):
    """按 'a.b.c' 取嵌套值；缺失返回 None（调用方决定是否 require）。"""
    cur = obj
    for part in path.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return None
    return cur


class Preflight:
    """只读消费 T0 preflight.json 的真实字段；一切路径/URL/命令均来自此文件或 CLI。"""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.doc = jload(path)
        schema = dig(self.doc, "schema")
        if schema != "yugang.anima-interaction-v1.preflight":
            raise RunnerError(f"preflight schema 不符：期望 yugang.anima-interaction-v1.preflight，实得 {schema!r}", EXIT_USAGE)

    # --- gateG0 / helper（controller 用）---
    @property
    def helper_remote_path(self) -> str:
        return require(dig(self.doc, "gateG0.helper.remotePath"), "preflight.gateG0.helper.remotePath")

    @property
    def helper_node(self) -> str:
        return require(dig(self.doc, "gateG0.helper.nodeUsed"), "preflight.gateG0.helper.nodeUsed")

    @property
    def helper_flags(self) -> str:
        return require(dig(self.doc, "gateG0.helper.flagsEveryCall"), "preflight.gateG0.helper.flagsEveryCall")

    @property
    def fish_deploy_commit(self) -> str:
        return require(dig(self.doc, "gateG0.deployCommit"), "preflight.gateG0.deployCommit")

    @property
    def fish_pid(self):
        return dig(self.doc, "gateG0.fishPid")

    # --- 隔离实例（worker 用）---
    @property
    def lab_url(self) -> str:
        return require(dig(self.doc, "isolatedInstance.url.loopbackReferenceOnly"), "preflight.isolatedInstance.url.loopbackReferenceOnly")

    @property
    def lab_root(self) -> str:
        return require(dig(self.doc, "isolatedInstance.labRoot"), "preflight.isolatedInstance.labRoot")

    @property
    def lab_pid(self):
        # T0b 启动后才有真实 PID；未启动为 null（worker 只记录，不据此 gate）。
        return dig(self.doc, "isolatedInstance.pid")

    @property
    def windows_python_exe(self) -> str:
        return require(dig(self.doc, "environment.python.exe"), "preflight.environment.python.exe")

    @property
    def experiment_core_commit(self):
        # 实验 core 冻结裁定（unclosed item 1）；主会话裁定后填。缺省用生产 commit 作记录值。
        return dig(self.doc, "coreVersionDrift.productionCommit")

    @property
    def connect_entry_note(self) -> str:
        return dig(self.doc, "isolatedInstance.executionChannel.entry") or "home-connect connect.sh (wsl-relay)"


# ══════════════════════════════════════════════════════════════════════════
# manifest.json 加载与校验（§8.1 冻结格式；T3a 产出，runner 只消费）
# ══════════════════════════════════════════════════════════════════════════
# 每个 job row 的必备键（§8.1 + §10）。存在性强制；语义空值按 sample_kind 条件放行。
JOB_REQUIRED_KEYS = [
    "job_id", "case_id", "pair", "action", "framing", "seed", "stage", "stage_seed",
    "method", "weights", "parent", "asset_hashes", "expected_visibility",
    "comparison_folders", "sample_kind", "depends_on", "reuse_of", "graph_path",
    "graph_hash", "expected_width", "expected_height", "input_files", "output_contract",
]
MANIFEST_TOP_REQUIRED = ["schema_version", "spec_sha256", "preflight_sha256", "jobs"]


class Manifest:
    def __init__(self, path: Path, expect_schema_version=None) -> None:
        self.path = path
        self.sha256 = sha256_file(path)
        self.doc = jload(path)
        self._validate(expect_schema_version)
        self.jobs = {j["job_id"]: j for j in self.doc["jobs"]}
        self._validate_graph_edges()

    def _validate(self, expect_schema_version) -> None:
        if not isinstance(self.doc, dict):
            raise RunnerError("manifest 顶层不是对象", EXIT_USAGE)
        for key in MANIFEST_TOP_REQUIRED:
            if key not in self.doc:
                raise RunnerError(f"manifest 缺顶层字段 {key}（§8.1 冻结格式）", EXIT_USAGE)
        sv = self.doc["schema_version"]
        if expect_schema_version is not None and sv != expect_schema_version:
            raise RunnerError(f"manifest schema_version={sv!r} 与 --expect-schema-version={expect_schema_version!r} 不符", EXIT_USAGE)
        jobs = self.doc["jobs"]
        if not isinstance(jobs, list) or not jobs:
            raise RunnerError("manifest.jobs 必须是非空数组（T3a 展开的完整 job 表）", EXIT_USAGE)
        seen = set()
        for i, job in enumerate(jobs):
            if not isinstance(job, dict):
                raise RunnerError(f"manifest.jobs[{i}] 不是对象", EXIT_USAGE)
            for key in JOB_REQUIRED_KEYS:
                if key not in job:
                    raise RunnerError(f"manifest.jobs[{i}] 缺字段 {key}（§8.1）；字段有疑问见 runner.md『接口疑问』，不私改", EXIT_USAGE)
            jid = job["job_id"]
            if not isinstance(jid, str) or not jid:
                raise RunnerError(f"manifest.jobs[{i}].job_id 非法", EXIT_USAGE)
            if jid in seen:
                raise RunnerError(f"manifest.jobs 重复 job_id {jid}", EXIT_USAGE)
            seen.add(jid)
            kind = job["sample_kind"]
            if kind not in ("new", "reuse"):
                raise RunnerError(f"job {jid} sample_kind={kind!r} 非法（只认 new|reuse）", EXIT_USAGE)
            oc = job["output_contract"]
            if not isinstance(oc, dict) or "image_node_ids" not in oc or "metadata_node_ids" not in oc:
                raise RunnerError(f"job {jid} output_contract 缺 image_node_ids/metadata_node_ids（§8.1）", EXIT_USAGE)
            if kind == "new":
                # 新采样行必须有可校验的图与输出契约。
                if not job.get("graph_path"):
                    raise RunnerError(f"new job {jid} 缺 graph_path", EXIT_USAGE)
                if not job.get("graph_hash"):
                    raise RunnerError(f"new job {jid} 缺 graph_hash（读取前须 hash 校验）", EXIT_USAGE)
                if not isinstance(oc["image_node_ids"], list) or not oc["image_node_ids"]:
                    raise RunnerError(f"new job {jid} output_contract.image_node_ids 为空", EXIT_USAGE)
                for dim in ("expected_width", "expected_height"):
                    if not isinstance(job.get(dim), int) or job[dim] <= 0:
                        raise RunnerError(f"new job {jid} {dim} 非法（须正整数）", EXIT_USAGE)
            else:  # reuse
                if not job.get("reuse_of"):
                    raise RunnerError(f"reuse job {jid} 缺 reuse_of（复用必须显式引用源 job，不 POST）", EXIT_USAGE)

    def _validate_graph_edges(self) -> None:
        ids = set(self.jobs)
        for jid, job in self.jobs.items():
            deps = self.dependencies_of(job)
            for d in deps:
                if d not in ids:
                    raise RunnerError(f"job {jid} 依赖 {d} 不在 manifest.jobs（depends_on/parent.source_job/reuse_of 指向未知 job）", EXIT_USAGE)
        # 环检测（Kahn）
        indeg = {jid: 0 for jid in ids}
        adj = {jid: [] for jid in ids}
        for jid, job in self.jobs.items():
            for d in self.dependencies_of(job):
                adj[d].append(jid)
                indeg[jid] += 1
        queue = [j for j in ids if indeg[j] == 0]
        order = []
        while queue:
            queue.sort()  # 确定性
            n = queue.pop(0)
            order.append(n)
            for m in adj[n]:
                indeg[m] -= 1
                if indeg[m] == 0:
                    queue.append(m)
        if len(order) != len(ids):
            raise RunnerError("manifest.jobs 依赖图存在环，无法拓扑调度", EXIT_USAGE)
        self._topo_order = order

    @staticmethod
    def dependencies_of(job) -> set:
        """依赖边 = depends_on[] ∪ parent.source_job ∪ reuse_of（只指向具体上游 job）。"""
        deps = set()
        d = job.get("depends_on")
        if isinstance(d, list):
            deps.update(x for x in d if isinstance(x, str))
        elif isinstance(d, str) and d:
            deps.add(d)
        parent = job.get("parent")
        if isinstance(parent, dict):
            sj = parent.get("source_job")
            if isinstance(sj, str) and sj:
                deps.add(sj)
        elif isinstance(parent, str) and parent:
            deps.add(parent)
        ro = job.get("reuse_of")
        if isinstance(ro, str) and ro:
            deps.add(ro)
        elif isinstance(ro, dict):
            sj = ro.get("job_id") or ro.get("source_job")
            if isinstance(sj, str) and sj:
                deps.add(sj)
        return deps

    def topo_order(self):
        return list(self._topo_order)

    @staticmethod
    def parent_source_job(job):
        parent = job.get("parent")
        if isinstance(parent, dict):
            return parent.get("source_job")
        if isinstance(parent, str) and parent:
            return parent
        return None

    @staticmethod
    def reuse_of_job(job):
        ro = job.get("reuse_of")
        if isinstance(ro, str) and ro:
            return ro
        if isinstance(ro, dict):
            return ro.get("job_id") or ro.get("source_job")
        return None


# ══════════════════════════════════════════════════════════════════════════
# submit-permit：controller 签发、worker 消费的短 TTL 受控提交许可（dead-man switch）
# ══════════════════════════════════════════════════════════════════════════
def issue_permit(gate_attestation: dict, lab_url: str, ttl: int, batch: dict, experiment_core_commit=None) -> dict:
    """从**真实** gate 核验结果签发许可；gateIntact 非 true 一律拒绝签发。

    gate_attestation 必须来自 controller gate-check 对 helper status JSON 的解析
    （含 gate.gateIntact、fishPid、deployCommit、configSha256、helperStatusSha256）。
    许可**不含**任何凭据/密钥/生产 URL；只有 loopback 隔离 URL 与 gate 事实。
    """
    gate = gate_attestation.get("gate") or {}
    if gate.get("gateIntact") is not True:
        raise RunnerError("gate.gateIntact != true，拒绝签发提交许可（不能靠旧 lease 自证互斥）", EXIT_STOP)
    permit = {
        "permit_version": PERMIT_VERSION,
        "nonce": str(uuid.uuid4()),
        "issuedAt": now_iso(),
        "issuedBy": f"interaction-study-run.py#controller/{RUNNER_VERSION}@{host_label()}",
        "ttlSeconds": int(ttl),
        "gate": {
            "gateIntact": True,
            "fishPid": gate_attestation.get("fishPid"),
            "deployCommit": gate_attestation.get("deployCommit"),
            "rawDrawEnabledKey": gate_attestation.get("rawDrawEnabledKey"),
            "configSha256": gate_attestation.get("configSha256"),
            "helperStatusSha256": gate_attestation.get("helperStatusSha256"),
            "issues": gate_attestation.get("issues", []),
        },
        "lab": {"url": lab_url, "experimentCoreCommit": experiment_core_commit},
        "batch": batch,
    }
    return permit


class PermitGate:
    """worker 侧许可新鲜度闸：抗 Mac/Windows 时钟偏移——以 worker 本地墙钟测量
    「距上次 nonce 变化」的时长，而非比较 controller 的 issuedAt。"""

    def __init__(self, permit_path: Path, lab_url: str, state: dict) -> None:
        self.permit_path = permit_path
        self.lab_url = lab_url
        self.state = state  # 持有 permit_last_nonce / permit_last_change_wall（持久化）

    def _read_permit(self):
        if not self.permit_path.exists():
            raise RunnerError(f"许可不存在：{self.permit_path}（worker 只按新鲜受控许可工作）", EXIT_STOP)
        permit = jload(self.permit_path)
        if permit.get("permit_version") != PERMIT_VERSION:
            raise RunnerError(f"许可版本不符：{permit.get('permit_version')}", EXIT_STOP)
        return permit

    def check_fresh(self) -> dict:
        """返回许可（新鲜且 gateIntact）或抛 RunnerError(EXIT_STOP) 停止新增提交。"""
        permit = self._read_permit()
        gate = permit.get("gate") or {}
        if gate.get("gateIntact") is not True:
            raise RunnerError("许可 gate.gateIntact != true（守护失联/热闸被破坏），停止新增提交；accepted 仍回查", EXIT_STOP)
        lab = permit.get("lab") or {}
        if lab.get("url") != self.lab_url:
            raise RunnerError(f"许可 lab.url={lab.get('url')!r} 与 worker --lab-url={self.lab_url!r} 不符，停止", EXIT_STOP)
        nonce = permit.get("nonce")
        ttl = int(permit.get("ttlSeconds", DEFAULT_PERMIT_TTL_S))
        now = time.time()
        last_nonce = self.state.get("permit_last_nonce")
        if nonce != last_nonce:
            # 收到新 nonce（controller 刚刷新）→ 记录本地接收时刻。
            self.state["permit_last_nonce"] = nonce
            self.state["permit_last_change_wall"] = now
        change_wall = float(self.state.get("permit_last_change_wall", 0.0))
        age = now - change_wall
        if age > ttl:
            raise RunnerError(
                f"许可过期：距上次 nonce 刷新 {age:.0f}s > ttl {ttl}s（守护未在刷新），停止新增提交；accepted 仍回查",
                EXIT_STOP,
            )
        return permit


# ══════════════════════════════════════════════════════════════════════════
# 隔离实例 HTTP 客户端（只认 loopback lab URL；不记凭据；不碰生产 8188）
# ══════════════════════════════════════════════════════════════════════════
class LabClient:
    def __init__(self, base_url: str, http_timeout: int = DEFAULT_HTTP_TIMEOUT_S, view_timeout: int = DEFAULT_VIEW_TIMEOUT_S) -> None:
        if not base_url.startswith("http://127.0.0.1:") and not base_url.startswith("http://localhost:"):
            # 隔离实例是 Windows 本地 loopback；拒绝任何非 loopback 目标，避免误连生产/外网。
            raise RunnerError(f"--lab-url 必须是隔离实例的 loopback 地址（http://127.0.0.1:<port>），实得 {base_url!r}", EXIT_USAGE)
        self.base = base_url.rstrip("/")
        self.http_timeout = http_timeout
        self.view_timeout = view_timeout

    def _get(self, path: str, timeout: int) -> bytes:
        req = urllib.request.Request(self.base + path, headers={"Accept": "application/json"}, method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()

    def get_json(self, path: str, timeout: int = None) -> dict:
        raw = self._get(path, timeout or self.http_timeout)
        return json.loads(raw)

    def queue(self) -> dict:
        q = self.get_json("/queue")
        running = q.get("queue_running")
        pending = q.get("queue_pending")
        if not isinstance(running, list) or not isinstance(pending, list):
            raise RunnerError("隔离实例 /queue 形状异常（queue_running/queue_pending 非数组）", EXIT_RUNTIME)
        return {"running": running, "pending": pending}

    def system_stats(self):
        try:
            return self.get_json("/system_stats")
        except Exception:
            return None

    def history(self, prompt_id: str) -> dict:
        return self.get_json("/history/" + urllib.parse.quote(prompt_id))

    def post_prompt(self, prompt: dict, client_id: str, prompt_id=None) -> dict:
        """POST /prompt。缺省**不**发客户端指定 prompt_id（服务端返回值为权威键）；
        仅当调用方显式给出 prompt_id（--client-prompt-id-verified）时才带上。"""
        payload = {"prompt": prompt, "client_id": client_id, "extra_data": {"client_id": client_id}}
        if prompt_id is not None:
            payload["prompt_id"] = prompt_id
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(self.base + "/prompt", data=body, headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=self.http_timeout) as resp:
            return json.loads(resp.read())

    def upload_image(self, filename: str, blob: bytes, overwrite: bool = True) -> dict:
        ctype, body = _multipart(
            fields={"type": "input", "overwrite": "true" if overwrite else "false"},
            files={"image": (filename, blob, "image/png")},
        )
        req = urllib.request.Request(self.base + "/upload/image", data=body, headers={"Content-Type": ctype}, method="POST")
        with urllib.request.urlopen(req, timeout=self.view_timeout) as resp:
            return json.loads(resp.read())

    def view(self, filename: str, subfolder: str, vtype: str) -> bytes:
        query = urllib.parse.urlencode({"filename": filename, "subfolder": subfolder or "", "type": vtype})
        return self._get("/view?" + query, self.view_timeout)


def _multipart(fields: dict, files: dict):
    boundary = ("----yugangStudyBoundary" + uuid.uuid4().hex).encode()
    out = []
    for k, v in fields.items():
        out.append(b"--" + boundary)
        out.append(f'Content-Disposition: form-data; name="{k}"'.encode())
        out.append(b"")
        out.append(str(v).encode())
    for k, (filename, blob, ctype) in files.items():
        out.append(b"--" + boundary)
        out.append(f'Content-Disposition: form-data; name="{k}"; filename="{filename}"'.encode())
        out.append(f"Content-Type: {ctype}".encode())
        out.append(b"")
        out.append(blob)
    out.append(b"--" + boundary + b"--")
    out.append(b"")
    return "multipart/form-data; boundary=" + boundary.decode(), b"\r\n".join(out)


# ══════════════════════════════════════════════════════════════════════════
# worker：state / results / generation-info 持久化
# ══════════════════════════════════════════════════════════════════════════
class WorkerStore:
    def __init__(self, run_root: Path, manifest: Manifest, lab_url: str, new_run: bool = False) -> None:
        self.run_root = run_root
        self.state_path = run_root / "state.json"
        self.results_path = run_root / "results.jsonl"
        self.gen_info_dir = run_root / "generation-info"
        self.images_dir = run_root / "images"
        self.manifest = manifest
        self.lab_url = lab_url
        self.state = self._load_or_init(new_run)

    def _blank_state(self) -> dict:
        return {
            "state_version": STATE_VERSION,
            "run_id": str(uuid.uuid4()),
            "runner_version": RUNNER_VERSION,
            "manifest_sha256": self.manifest.sha256,
            "lab_url": self.lab_url,
            "worker_host": host_label(),
            "started_at": now_iso(),
            "updated_at": now_iso(),
            "permit_last_nonce": None,
            "permit_last_change_wall": 0.0,
            "jobs": {},
            "resume_point": None,
        }

    def _load_or_init(self, new_run: bool) -> dict:
        if self.state_path.exists():
            existing = jload(self.state_path)
            if existing.get("state_version") != STATE_VERSION:
                raise RunnerError(f"state.json state_version 不符（{existing.get('state_version')}），拒绝覆盖未知旧 run", EXIT_RUNTIME)
            if existing.get("manifest_sha256") != self.manifest.sha256:
                if not new_run:
                    raise RunnerError(
                        "state.json 属于另一份 manifest（sha 不符）——不覆盖未知旧 run；如确要新建请加 --new-run（会先归档旧 state）",
                        EXIT_RUNTIME,
                    )
                archived = self.state_path.with_name(f"state.closed-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json")
                atomic_write_json(archived, existing)
                self.state_path.unlink()
            else:
                # 同一 manifest：reattach（断线重连），不重置在途任务。
                return existing
        st = self._blank_state()
        for jid in self.manifest.jobs:
            st["jobs"][jid] = {"status": "pending"}
        self._persist(st)
        return st

    def _persist(self, state: dict) -> None:
        state["updated_at"] = now_iso()
        atomic_write_json(self.state_path, state)

    def save(self) -> None:
        self._persist(self.state)

    def job(self, job_id: str) -> dict:
        return self.state["jobs"].setdefault(job_id, {"status": "pending"})

    def set_job(self, job_id: str, **fields) -> None:
        j = self.job(job_id)
        j.update(fields)
        j["updated_at"] = now_iso()
        self.save()

    def append_result(self, row: dict) -> None:
        row = {"recorded_at": now_iso(), "run_id": self.state["run_id"], **row}
        append_jsonl(self.results_path, row)

    def open_submitted_job_ids(self):
        return sorted(jid for jid, j in self.state["jobs"].items() if j.get("status") in OPEN_SUBMITTED_STATES)

    def stop_scheduling_job_ids(self):
        return sorted(jid for jid, j in self.state["jobs"].items() if j.get("status") in STOP_SCHEDULING_STATES)


# ══════════════════════════════════════════════════════════════════════════
# worker：核心执行
# ══════════════════════════════════════════════════════════════════════════
class Worker:
    def __init__(self, args, manifest: Manifest, store: WorkerStore, permit: PermitGate, lab: LabClient) -> None:
        self.args = args
        self.manifest = manifest
        self.store = store
        self.permit = permit
        self.lab = lab
        self.run_root = store.run_root
        self.client_prompt_id_verified = bool(getattr(args, "client_prompt_id_verified", False))

    # --- 图加载 + hash 校验（读取前）---
    def load_verified_graph(self, job: dict) -> bytes:
        gp = job["graph_path"]
        graph_path = Path(gp)
        if not graph_path.is_absolute():
            graph_path = (self.run_root / gp).resolve()
        if not graph_path.exists():
            raise RunnerError(f"job {job['job_id']} graph_path 不存在：{graph_path}（不填假路径）", EXIT_RUNTIME)
        raw = graph_path.read_bytes()
        actual = sha256_hex(raw)
        if actual != job["graph_hash"]:
            raise RunnerError(
                f"job {job['job_id']} graph_hash 不符：manifest={job['graph_hash']} 实际={actual}（图被改/错绑），拒绝 POST",
                EXIT_RUNTIME,
            )
        # 图必须是合法 JSON 对象（ComfyUI API prompt 形态：node_id -> {class_type, inputs}）
        graph = json.loads(raw)
        if not isinstance(graph, dict) or not graph:
            raise RunnerError(f"job {job['job_id']} graph 不是非空对象", EXIT_RUNTIME)
        return raw

    # --- 输入上传（parent 显式 source_job / structure 资产），hash 校验后传到隔离 input ---
    def ensure_inputs(self, job: dict) -> list:
        """把 input_files 上传到隔离实例 input 目录，返回上传记录。

        预期 input_files item 形态（与 T3a 对齐，见 runner.md『接口疑问』；不符即拒，不私改）：
          { "target": "<隔离 input 里的文件名，图内 LoadImage 必须引用它>",
            "source": { "kind": "structure"|"parent_job"|"run_root_file",
                        "path": "<structure/run_root_file 的路径，绝对或相对 run-root>",
                        "job_id": "<parent_job 的上游 job_id>",
                        "output_node_id": "<parent_job 取哪个输出节点，缺省用其首个 image_node>",
                        "sha256": "<structure/run_root_file 的冻结 hash；parent_job 不预填>" } }
        """
        jid = job["job_id"]
        records = []
        input_files = job.get("input_files") or []
        if not isinstance(input_files, list):
            raise RunnerError(f"job {jid} input_files 不是数组", EXIT_USAGE)
        for item in input_files:
            if not isinstance(item, dict) or "target" not in item or "source" not in item:
                raise RunnerError(f"job {jid} input_files item 缺 target/source（预期形态见 runner.md），拒绝猜测", EXIT_USAGE)
            target = item["target"]
            if not safe_output_filename(target):
                raise RunnerError(f"job {jid} input target 文件名不安全：{target!r}", EXIT_USAGE)
            src = item["source"]
            kind = src.get("kind")
            if kind == "parent_job":
                up_id = src.get("job_id")
                if not up_id:
                    raise RunnerError(f"job {jid} input source.kind=parent_job 缺 job_id", EXIT_USAGE)
                up = self.store.job(up_id)
                up_status = up.get("status")
                if up_status not in ("success", "reuse_resolved"):
                    raise RunnerError(f"job {jid} 的父图 {up_id} 尚未闭合可用（当前 {up_status}），不能上传不存在的图", EXIT_RUNTIME)
                up_outputs = up.get("outputs") if up_status == "success" else up.get("reused_outputs") or {}
                node_id = src.get("output_node_id") or (up_outputs.get("image_node_ids") or [None])[0]
                local_png = (up_outputs.get("files") or {}).get(str(node_id))
                if not local_png:
                    raise RunnerError(f"job {jid} 父图 {up_id} 节点 {node_id} 无本地 PNG 记录", EXIT_RUNTIME)
                blob = Path(local_png).read_bytes()
                # 核 hash 与上游记录一致（父图产出后核 hash，再复制到隔离 input）
                recorded_hash = (up_outputs.get("hashes") or {}).get(str(node_id))
                actual = sha256_hex(blob)
                if recorded_hash and actual != recorded_hash:
                    raise RunnerError(f"job {jid} 父图 {up_id}/{node_id} hash 漂移：记录={recorded_hash} 实际={actual}", EXIT_RUNTIME)
                expected_sha = src.get("sha256")
                if expected_sha and actual != expected_sha:
                    raise RunnerError(f"job {jid} 父图 hash 与 manifest 期望不符：{expected_sha} != {actual}", EXIT_RUNTIME)
            elif kind in ("structure", "run_root_file"):
                p = src.get("path")
                if not p:
                    raise RunnerError(f"job {jid} input source.kind={kind} 缺 path", EXIT_USAGE)
                pp = Path(p)
                if not pp.is_absolute():
                    pp = (self.run_root / p).resolve()
                if not pp.exists():
                    raise RunnerError(f"job {jid} input 文件不存在：{pp}", EXIT_RUNTIME)
                blob = pp.read_bytes()
                expected_sha = src.get("sha256")
                if expected_sha:
                    actual = sha256_hex(blob)
                    if actual != expected_sha:
                        raise RunnerError(f"job {jid} input {target} hash 不符：manifest={expected_sha} 实际={actual}", EXIT_RUNTIME)
                elif kind == "structure":
                    # structure 资产应带冻结 hash；缺失是可核验性缺口，明确拒绝（不猜）。
                    raise RunnerError(f"job {jid} structure input {target} 缺 sha256（结构资产须冻结 hash）", EXIT_USAGE)
            else:
                raise RunnerError(f"job {jid} input source.kind={kind!r} 未知（只认 structure|parent_job|run_root_file）", EXIT_USAGE)
            # 上传到隔离 input（回显核对 target；type=input；不接受意外路径）
            up = self.lab.upload_image(target, blob, overwrite=True)
            if up.get("name") != target or up.get("subfolder") or up.get("type") != "input":
                raise RunnerError(f"job {jid} 上传回显异常：{up!r}（期望 name={target}, subfolder 空, type=input）", EXIT_RUNTIME)
            records.append({"target": target, "kind": kind, "bytes": len(blob), "sha256": sha256_hex(blob), "upload": up})
        return records

    # --- 提交（先持久化 submitting+client_id，再 POST；异常一律不重 POST）---
    def submit(self, job: dict, graph_raw: bytes, permit: dict) -> str:
        jid = job["job_id"]
        client_id = str(uuid.uuid4())
        graph = json.loads(graph_raw)
        pre_prompt_id = str(uuid.uuid4()) if self.client_prompt_id_verified else None
        # ★ 先持久化 submitting + 预分配 client_id（POST 之前）
        self.store.set_job(
            jid,
            status="submitting",
            client_id=client_id,
            pre_prompt_id=pre_prompt_id,
            graph_hash=job["graph_hash"],
            permit_nonce=permit.get("nonce"),
            submitted_at=now_iso(),
        )
        # 保存提交的确切 prompt 图（闭合 schema/graph/record）
        atomic_write_text(self.store.gen_info_dir / f"{jid}-submitted-graph.json", json.dumps(graph, ensure_ascii=False, indent=2) + "\n")
        try:
            resp = self.lab.post_prompt(graph, client_id, prompt_id=pre_prompt_id)
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", errors="replace")[:500]
            except Exception:
                pass
            # 4xx 明确被拒（未入队）→ 记 execution_error（可重试是另派决定，本进程不重 POST）。
            if 400 <= e.code < 500:
                self.store.set_job(jid, status="execution_error", error_class="rejected_http_%d" % e.code, error_detail=detail)
                self._result_row(job, "execution_error", error_class="rejected_http_%d" % e.code, error_detail=detail)
                return "execution_error"
            # 5xx / 其它 → 提交状态不明 → unknown（不重 POST）
            self.store.set_job(jid, status="unknown", error_class="post_http_%d" % e.code, error_detail=detail)
            return "unknown"
        except Exception as e:  # URLError / timeout / reset → 状态不明
            self.store.set_job(jid, status="unknown", error_class="post_network", error_detail=str(e)[:300])
            return "unknown"
        server_prompt_id = resp.get("prompt_id")
        if self.client_prompt_id_verified:
            # 已验证模式：我们预分配的 prompt_id 是权威键；回显须一致。
            if server_prompt_id != pre_prompt_id:
                self.store.set_job(jid, status="unknown", error_class="prompt_id_mismatch_verified", error_detail=f"sent={pre_prompt_id} got={server_prompt_id}")
                return "unknown"
            prompt_id = pre_prompt_id
        else:
            # 缺省模式：以服务端返回 prompt_id 为权威键（不假设客户端指定被采纳）。
            if not isinstance(server_prompt_id, str) or not server_prompt_id:
                self.store.set_job(jid, status="unknown", error_class="no_prompt_id_echo", error_detail=json.dumps(resp)[:300])
                return "unknown"
            prompt_id = server_prompt_id
        self.store.set_job(jid, status="accepted", prompt_id=prompt_id, accepted_at=now_iso())
        return "accepted"

    # --- unknown 关联回查（有界；绝不重 POST）---
    def correlate_unknown(self, job: dict) -> str:
        jid = job["job_id"]
        st = self.store.job(jid)
        client_id = st.get("client_id")
        pre_prompt_id = st.get("pre_prompt_id")
        # (a) 已验证客户端 prompt_id：直接查 history。
        if pre_prompt_id:
            try:
                h = self.lab.history(pre_prompt_id).get(pre_prompt_id)
                if h:
                    self.store.set_job(jid, status="accepted", prompt_id=pre_prompt_id, correlated_by="history_pre_prompt_id")
                    return "accepted"
            except Exception:
                pass
        # (b) 扫隔离队列，用 client_id/job_id/prompt 关联（隔离实例单一用途，唯一回查）。
        try:
            q = self.lab.queue()
        except Exception as e:
            self.store.set_job(jid, status="unresolved", error_class="correlate_queue_unreachable", error_detail=str(e)[:200])
            return "unresolved"
        for section in ("running", "pending"):
            for entry in q.get(section, []):
                blob = json.dumps(entry, ensure_ascii=False)
                matched = None
                if isinstance(entry, list) and len(entry) >= 2 and isinstance(entry[1], str):
                    cand = entry[1]
                    if client_id and client_id in blob:
                        matched = cand
                if matched is None and client_id and client_id in blob:
                    # 退化：条目里出现我们的 client_id，但无法定位 prompt_id 字段 → 不猜键
                    matched = "client_id_present_but_prompt_id_unlocated"
                if matched and matched != "client_id_present_but_prompt_id_unlocated":
                    self.store.set_job(jid, status="accepted", prompt_id=matched, correlated_by=f"queue_{section}")
                    return "accepted"
                if matched == "client_id_present_but_prompt_id_unlocated":
                    self.store.set_job(jid, status="unresolved", error_class="correlate_ambiguous", error_detail="client_id in queue but prompt_id key location unverified (protocol point)")
                    return "unresolved"
        # (c) 队列里没有：要么已秒完成（无 prompt_id 无法定位），要么从未入队 → unresolved，停止调度。
        self.store.set_job(
            jid,
            status="unresolved",
            error_class="correlate_not_found",
            error_detail="POST outcome unknown; not in queue; no verified client prompt_id to re-query. Needs protocol-verified correlation dispatch. NOT re-posted.",
        )
        return "unresolved"

    # --- 轮询 history（上限 job_timeout；超时记 observation_timeout，不伪装取消）---
    def poll(self, job: dict) -> str:
        jid = job["job_id"]
        st = self.store.job(jid)
        prompt_id = st.get("prompt_id")
        if not prompt_id:
            raise RunnerError(f"job {jid} poll 缺 prompt_id（状态 {st.get('status')}）", EXIT_RUNTIME)
        deadline = time.monotonic() + float(self.args.job_timeout_seconds)
        interval = float(self.args.poll_interval_seconds)
        while time.monotonic() < deadline:
            try:
                h = self.lab.history(prompt_id).get(prompt_id)
            except Exception:
                h = None  # 瞬时网络错误：继续轮询到 deadline（不取消、不重 POST）
            if h:
                # 原 JSON 落盘（审计闭合，不从 stdout 猜）
                atomic_write_text(self.store.gen_info_dir / f"{jid}-history.json", json.dumps(h, ensure_ascii=False, indent=2) + "\n")
                status = h.get("status") or {}
                ok = status.get("status_str") == "success" and status.get("completed") is True
                if not ok:
                    self.store.set_job(jid, status="execution_error", error_class="history_not_success", prompt_id=prompt_id, history_status=status)
                    self._result_row(job, "execution_error", prompt_id=prompt_id, error_class="history_not_success", history_status=status)
                    return "execution_error"
                return self.collect(job, h)
            time.sleep(interval)
        # 超时：只记 observation_timeout/unresolved，绝不认定服务端已取消。
        self.store.set_job(jid, status="observation_timeout", error_class="observation_timeout", prompt_id=prompt_id, timeout_seconds=self.args.job_timeout_seconds)
        self._result_row(job, "observation_timeout", prompt_id=prompt_id, error_class="observation_timeout")
        return "observation_timeout"

    # --- 收集输出：PNG（image_node_ids）+ study_metadata（metadata_node_ids）原文 ---
    def collect(self, job: dict, history_entry: dict) -> str:
        jid = job["job_id"]
        oc = job["output_contract"]
        image_nodes = oc.get("image_node_ids") or []
        meta_nodes = oc.get("metadata_node_ids") or []
        outputs = history_entry.get("outputs") or {}
        files = {}
        hashes = {}
        dims = {}
        # 图片
        for node_id in image_nodes:
            images = (outputs.get(str(node_id)) or {}).get("images")
            if not isinstance(images, list) or len(images) != 1:
                self.store.set_job(jid, status="execution_error", error_class="image_output_missing", node_id=node_id)
                self._result_row(job, "execution_error", error_class="image_output_missing", node_id=node_id)
                return "execution_error"
            loc = images[0]
            filename = loc.get("filename")
            subfolder = loc.get("subfolder") or ""
            vtype = loc.get("type")
            if not safe_output_filename(filename):
                self.store.set_job(jid, status="execution_error", error_class="image_locator_unsafe", locator=loc)
                self._result_row(job, "execution_error", error_class="image_locator_unsafe", locator=loc)
                return "execution_error"
            if vtype not in ("temp", "output"):
                self.store.set_job(jid, status="execution_error", error_class="image_locator_type_unknown", locator=loc)
                self._result_row(job, "execution_error", error_class="image_locator_type_unknown", locator=loc)
                return "execution_error"
            try:
                blob = self.lab.view(filename, subfolder, vtype)
            except Exception as e:
                self.store.set_job(jid, status="execution_error", error_class="view_failed", detail=str(e)[:200], locator=loc)
                self._result_row(job, "execution_error", error_class="view_failed", locator=loc)
                return "execution_error"
            pdims = png_dimensions(blob)
            if pdims is None:
                self.store.set_job(jid, status="execution_error", error_class="not_a_png", locator=loc, bytes=len(blob))
                self._result_row(job, "execution_error", error_class="not_a_png", locator=loc)
                return "execution_error"
            w, h = pdims
            if w != job["expected_width"] or h != job["expected_height"]:
                self.store.set_job(jid, status="execution_error", error_class="dimension_mismatch", actual=[w, h], expected=[job["expected_width"], job["expected_height"]], locator=loc)
                self._result_row(job, "execution_error", error_class="dimension_mismatch", actual=[w, h], expected=[job["expected_width"], job["expected_height"]])
                return "execution_error"
            out_dir = self.store.images_dir / jid
            out_dir.mkdir(parents=True, exist_ok=True)
            out_path = out_dir / f"{node_id}_{filename}"
            out_path.write_bytes(blob)
            files[str(node_id)] = str(out_path)
            hashes[str(node_id)] = sha256_hex(blob)
            dims[str(node_id)] = [w, h]
        # metadata（ui.study_metadata 字符串列表原文；缺失记录为缺口，不从 stdout 猜）
        meta_records = {}
        for node_id in meta_nodes:
            node_out = outputs.get(str(node_id)) or {}
            study = node_out.get("study_metadata")
            if study is None:
                meta_records[str(node_id)] = {"present": False, "note": "ui.study_metadata absent in history outputs (protocol point: confirm ui key form)"}
            else:
                meta_records[str(node_id)] = {"present": True, "study_metadata": study}
        atomic_write_text(self.store.gen_info_dir / f"{jid}-study_metadata.json", json.dumps(meta_records, ensure_ascii=False, indent=2) + "\n")
        self.store.set_job(
            jid,
            status="success",
            closed_at=now_iso(),
            outputs={"image_node_ids": image_nodes, "metadata_node_ids": meta_nodes, "files": files, "hashes": hashes, "dimensions": dims, "study_metadata_present": all(v.get("present") for v in meta_records.values()) if meta_records else None},
        )
        self._result_row(job, "success", outputs={"files": files, "hashes": hashes, "dimensions": dims}, study_metadata=meta_records)
        return "success"

    # --- reuse：不 POST，只把引用绑定到已闭合上游 job 的输出 ---
    def resolve_reuse(self, job: dict) -> str:
        jid = job["job_id"]
        ref = self.manifest.reuse_of_job(job)
        up = self.store.job(ref)
        up_status = up.get("status")
        # 上游须为真实成功采样（success）或已解析的复用（reuse_resolved，链式引用）。
        if up_status == "success":
            reused = up.get("outputs")
        elif up_status == "reuse_resolved":
            reused = up.get("reused_outputs")
        else:
            raise RunnerError(f"reuse job {jid} 引用的 {ref} 尚未 success/reuse_resolved（当前 {up_status}），无法绑定复用", EXIT_RUNTIME)
        self.store.set_job(jid, status="reuse_resolved", closed_at=now_iso(), reuse_of=ref, reused_outputs=reused)
        self._result_row(job, "reuse_resolved", reuse_of=ref, reused_outputs=reused)
        return "reuse_resolved"

    # --- 机械跳过（投影编辑域空/出画、缺父文件等；不据视觉判断）---
    def mechanical_skip(self, job: dict, reason: str) -> str:
        jid = job["job_id"]
        self.store.set_job(jid, status="skipped_mechanical", closed_at=now_iso(), skip_reason=reason)
        self._result_row(job, "skipped_mechanical", skip_reason=reason)
        return "skipped_mechanical"

    def _result_row(self, job: dict, status: str, **extra) -> None:
        """结果行含原 job_id、prompt_id、终态/时间/输出 hash/错误分类、generation_info 路径（§10）。"""
        jid = job["job_id"]
        st = self.store.job(jid)
        row = {
            "job_id": jid,
            "case_id": job.get("case_id"),
            "pair": job.get("pair"),
            "action": job.get("action"),
            "framing": job.get("framing"),
            "seed": job.get("seed"),
            "stage": job.get("stage"),
            "stage_seed": job.get("stage_seed"),
            "method": job.get("method"),
            "weights": job.get("weights"),
            "sample_kind": job.get("sample_kind"),
            "status": status,
            "prompt_id": st.get("prompt_id"),
            "client_id": st.get("client_id"),
            "graph_path": job.get("graph_path"),
            "graph_hash": job.get("graph_hash"),
            "expected_visibility": job.get("expected_visibility"),
            "comparison_folders": job.get("comparison_folders"),
            "asset_hashes": job.get("asset_hashes"),
            "generation_info": {
                "history": str(self.store.gen_info_dir / f"{jid}-history.json"),
                "study_metadata": str(self.store.gen_info_dir / f"{jid}-study_metadata.json"),
                "submitted_graph": str(self.store.gen_info_dir / f"{jid}-submitted-graph.json"),
            },
        }
        row.update(extra)
        self.store.append_result(row)

    # --- 主批循环 ---
    def run_batch(self) -> int:
        args = self.args
        max_new = args.max_new_jobs
        max_wall = args.max_wallclock_seconds
        start_mono = time.monotonic()
        # ── 安全预算修复（2026-11-12）──────────────────────────────────────────
        # 缺陷（full-execution-batch-1.json 实证）：旧码 new_posted 只在 accepted 时 +1，
        # 而 submit 返回 execution_error（HTTP 4xx 明确被拒）时走 continue 且不计数，
        # 预算闸 `new_posted >= max_new` 因此只约束「已接受」数、不约束「POST 尝试」数。
        # 系统性 400 下 worker 会沿拓扑序持续 POST（max-new-jobs=1 仍发了 345 次）。
        # 修复：max-new-jobs 改为约束**真实新 job POST 尝试**（attempted_new_jobs），
        # 每次 submit() 前机械 +1（无论最终 accepted/execution_error/unknown 都消耗预算）；
        # 且 submit 返回 execution_error（4xx）时 fail-closed 立即停止本轮新增（不再扫拓扑）。
        attempted_new_jobs = 0  # 每次真实新 job POST 尝试 +1（预算计量口径）
        new_accepted = 0        # 被隔离实例接受并拿到 prompt_id 的 POST 数（旧 new_posted 语义）
        reject_stop = False     # 是否因 HTTP 4xx 明确拒绝而 fail-closed 停止（→ EXIT_STOP）
        order = self.manifest.topo_order()
        stop_reason = None

        # 先处理已在途（断线重连）：accepted 重新挂轮询，submitting/unknown 关联回查。
        for jid in order:
            st = self.store.job(jid)
            status = st.get("status")
            if status == "accepted":
                outcome = self.poll(self.manifest.jobs[jid])
                if outcome in STOP_SCHEDULING_STATES or outcome == "execution_error":
                    stop_reason = f"reattach poll {jid} -> {outcome}"
                    break
            elif status in ("submitting", "unknown"):
                outcome = self.correlate_unknown(self.manifest.jobs[jid])
                if outcome in ("unresolved",):
                    stop_reason = f"reattach correlate {jid} -> unresolved"
                    break

        if stop_reason is None:
            for jid in order:
                job = self.manifest.jobs[jid]
                st = self.store.job(jid)
                status = st.get("status")
                if status in CLOSED_STATES:
                    continue
                if status in OPEN_SUBMITTED_STATES:
                    # 在途未决（上一轮遗留）：不新 POST，尝试推进。
                    if status == "accepted":
                        outcome = self.poll(job)
                    else:
                        outcome = self.correlate_unknown(job)
                    if outcome in STOP_SCHEDULING_STATES or outcome == "execution_error":
                        stop_reason = f"open job {jid} -> {outcome}（停止新增提交）"
                        break
                    continue
                # status == pending —— 先做上游依赖健康闸（拓扑序 + 串行处理保证依赖已终态）
                dep_skip = None
                dep_stop = None
                for dep in self.manifest.dependencies_of(job):
                    dst = self.store.job(dep).get("status")
                    if dst in ("success", "reuse_resolved"):
                        continue
                    if dst in ("execution_error", "skipped_mechanical"):
                        # 上游失败/机械跳过 → 本 job 无法进行：机械跳过并保留父图/记录（计划 §5.2）
                        dep_skip = f"上游 {dep} 终态 {dst}（非 success），机械跳过并保留父图/记录"
                        break
                    # pending / 在途未决 → 不能推进，停止新增提交
                    dep_stop = f"上游 {dep} 未闭合（{dst}），停止新增提交"
                    break
                if dep_skip:
                    self.mechanical_skip(job, dep_skip)
                    continue
                if dep_stop:
                    stop_reason = dep_stop
                    break
                if job["sample_kind"] == "reuse":
                    try:
                        self.resolve_reuse(job)
                    except RunnerError as e:
                        stop_reason = f"reuse {jid} 无法绑定：{e}"
                        break
                    continue
                # 新采样：预算闸（安全修复：max-new-jobs 现约束 **POST 尝试数**，不是 accepted 数）
                if max_new is not None and attempted_new_jobs >= max_new:
                    stop_reason = f"达到 --max-new-jobs={max_new}（POST 尝试 {attempted_new_jobs}），停止新增提交（不补 seed、不扩预算）"
                    break
                if max_wall is not None and (time.monotonic() - start_mono) >= max_wall:
                    stop_reason = f"达到 --max-wallclock-seconds={max_wall}，停止新增提交"
                    break
                # 许可新鲜 + gateIntact（守护失联/过期即停）
                try:
                    permit = self.permit.check_fresh()
                except RunnerError as e:
                    stop_reason = f"许可闸拒绝：{e}"
                    break
                # 隔离队列空闲核实（一次一个；外部任务不清不抢）
                try:
                    q = self.lab.queue()
                except Exception as e:
                    stop_reason = f"隔离队列不可读（fail-closed，不 POST）：{e}"
                    break
                if q["running"] or q["pending"]:
                    foreign = self._queue_has_foreign(q)
                    if foreign:
                        stop_reason = "隔离队列存在非本实验任务，不清队列/不抢资源，停止新增提交"
                        break
                    # 队列里是我们自己刚 accepted 的：等它（不并发第二个）
                    stop_reason = "隔离队列仍有本实验在途任务，保持一次一个，停止本轮新增"
                    break
                # 图 hash 校验 + 输入上传 + 提交（预备失败一律 fail-closed 停止，不猜）
                try:
                    graph_raw = self.load_verified_graph(job)
                    self.ensure_inputs(job)
                except RunnerError as e:
                    stop_reason = f"job {jid} 预备失败（fail-closed）：{e}"
                    break
                # ★ 机械计数本次真实新 job POST 尝试：无论最终 accepted / execution_error / unknown，
                #   都消耗本进程的新提交预算（max-new-jobs）。自增紧贴 submit() 之前——submit() 内部
                #   捕获全部 HTTP/网络异常并返回状态串、绝不抛出，故 +1 必然对应一次真实 POST 尝试。
                #   预备失败（图 hash / 输入上传）已在上方 break，不计入 POST 尝试。
                attempted_new_jobs += 1
                outcome = self.submit(job, graph_raw, permit)
                if outcome == "accepted":
                    new_accepted += 1
                    poll_outcome = self.poll(job)
                    if poll_outcome in STOP_SCHEDULING_STATES or poll_outcome == "execution_error":
                        stop_reason = f"job {jid} poll -> {poll_outcome}（停止新增提交）"
                        break
                elif outcome in STOP_SCHEDULING_STATES:
                    # unknown：尝试有界关联；仍不成即停止调度（绝不重 POST）。
                    corr = self.correlate_unknown(job)
                    if corr == "accepted":
                        new_accepted += 1
                        poll_outcome = self.poll(job)
                        if poll_outcome in STOP_SCHEDULING_STATES or poll_outcome == "execution_error":
                            stop_reason = f"job {jid} (correlated) poll -> {poll_outcome}"
                            break
                    else:
                        stop_reason = f"job {jid} 提交状态不明 -> {corr}，停止调度（不重 POST）"
                        break
                elif outcome == "execution_error":
                    # 明确被拒（HTTP 4xx，未入队 / 未占 GPU）：submit() 已记 execution_error 与 results 行。
                    # 安全修复（fail-closed）：立即设 stop_reason 并停止本轮新增——不再沿拓扑 continue 扫描、
                    # 不自动重试 / 补 seed。旧码此处 `continue` 正是 344 次系统性 400 仍持续 POST 的根因。
                    # accepted 后的 poll/collect 错误同样停止新增，先修复再续跑，
                    # 避免未验证的节点接口错误沿整个组持续扩散。
                    reject_stop = True
                    stop_reason = f"job {jid} 提交被明确拒绝（execution_error/HTTP 4xx），fail-closed 停止新增（不继续扫拓扑、不自动重试）"
                    break

        # 写精确续接点
        resume_point = {
            "at": now_iso(),
            "stop_reason": stop_reason,
            # 安全修复：区分「POST 尝试数」与「被接受数」两个口径——
            #   post_attempts_this_process = 本进程真实新 job POST 尝试总数（预算计量，≥ new_accepted）；
            #   new_accepted_this_process  = 其中被隔离实例接受并拿到 prompt_id 的数量；
            #   new_posted_this_process    = 向后兼容旧 state 的别名（= new_accepted，语义与旧字段一致，
            #                                不改旧字段含义、不伪改既有 run 证据）；
            #   reject_stop                = 是否因 HTTP 4xx 明确拒绝而 fail-closed 停止。
            "post_attempts_this_process": attempted_new_jobs,
            "new_accepted_this_process": new_accepted,
            "new_posted_this_process": new_accepted,
            "reject_stop": reject_stop,
            "open_submitted_job_ids": self.store.open_submitted_job_ids(),
            "stop_scheduling_job_ids": self.store.stop_scheduling_job_ids(),
            "next_pending": [jid for jid in order if self.store.job(jid).get("status") == "pending"][:20],
        }
        self.store.state["resume_point"] = resume_point
        self.store.save()
        print(json.dumps({"event": "batch_end", **resume_point}, ensure_ascii=False, indent=2))
        if stop_reason and (reject_stop or self.store.stop_scheduling_job_ids() or "不明" in stop_reason or "外部任务" in stop_reason or "许可" in stop_reason):
            return EXIT_STOP
        return EXIT_OK

    def _queue_has_foreign(self, q: dict) -> bool:
        """判断隔离队列里的任务是否非本实验（本 worker 是唯一提交者，故任何未在我们
        state 里登记为 accepted 的 prompt_id 都算外部）。"""
        known = set()
        for jid, j in self.store.state["jobs"].items():
            pid = j.get("prompt_id")
            if pid and j.get("status") in ("accepted", "running", "submitting", "unknown"):
                known.add(pid)
        for section in ("running", "pending"):
            for entry in q.get(section, []):
                pid = entry[1] if isinstance(entry, list) and len(entry) >= 2 and isinstance(entry[1], str) else None
                if pid and pid not in known:
                    return True
                if pid is None:
                    return True  # 形状不认识 → 保守当外部
        return False


# ══════════════════════════════════════════════════════════════════════════
# worker：closure（只在全部已提交任务闭合 + 隔离队列新鲜空闲时产 jobs-closed.json）
# ══════════════════════════════════════════════════════════════════════════
def worker_closure(args, manifest: Manifest, store: WorkerStore, lab: LabClient) -> int:
    open_ids = store.open_submitted_job_ids()
    # 隔离队列新鲜空闲核实
    try:
        q = lab.queue()
    except Exception as e:
        raise RunnerError(f"closure 无法核实隔离队列（fail-closed）：{e}", EXIT_RUNTIME)
    queue_idle = not q["running"] and not q["pending"]
    experiment_jobs_closed = len(open_ids) == 0 and queue_idle
    if not experiment_jobs_closed:
        print(json.dumps({
            "event": "closure_refused",
            "queueIdle": queue_idle,
            "experimentJobsClosed": False,
            "openJobIds": open_ids,
            "reason": "存在未闭合的已提交任务或队列非空闲；不产 jobs-closed.json，不能用未完成 run 误恢复鱼",
        }, ensure_ascii=False, indent=2))
        return EXIT_STOP
    proof = {
        "queueIdle": True,
        "experimentJobsClosed": True,
        "openJobIds": [],
        "attestedBy": f"interaction-study-run.py#worker/{RUNNER_VERSION}@{host_label()}:{store.state['run_id']}",
        "attestedAt": now_iso(),
        "runId": store.state["run_id"],
        "manifestSha256": manifest.sha256,
        "note": "attests: no open experiment GPU activity now. G1 restore (separate dispatch) consumes this via interaction-resource.ts restore --jobs-closed. Pending-unsubmitted jobs do NOT block closure (never touched GPU); continuation batches re-establish the gate.",
    }
    out = Path(args.jobs_closed_out) if getattr(args, "jobs_closed_out", None) else (store.run_root / "jobs-closed.json")
    atomic_write_json(out, proof)
    print(json.dumps({"event": "closure_formed", "path": str(out), **proof}, ensure_ascii=False, indent=2))
    return EXIT_OK


# ══════════════════════════════════════════════════════════════════════════
# controller：gate-check（经 connect.sh mac 跑 helper status，解析 gateIntact）
# ══════════════════════════════════════════════════════════════════════════
def build_helper_status_command(pf: Preflight, args) -> tuple:
    node = getattr(args, "node_remote", None) or pf.helper_node
    helper = getattr(args, "helper_remote_path", None) or pf.helper_remote_path
    flags = getattr(args, "helper_flags", None) or pf.helper_flags
    if not flags.split()[0] == "status":
        raise RunnerError(f"helper flags 必须以 status 开头（实得 {flags!r}）", EXIT_USAGE)
    connect = getattr(args, "connect_sh", None) or os.path.expanduser("~/.agents/skills/home-connect/scripts/connect.sh")
    remote_cmd = f"{node} {helper} {flags}"
    return connect, remote_cmd


def controller_gate_check(args) -> int:
    pf = Preflight(Path(require(args.preflight, "--preflight")))
    connect, remote_cmd = build_helper_status_command(pf, args)
    full = [connect, "mac", "--", remote_cmd]
    if not args.execute:
        print(json.dumps({
            "event": "gate_check_print_only",
            "command": full,
            "note": "print-only（本轮不发起真实 relay）。真实核验加 --execute；解析 stdout 的 helper status JSON，取 gate.gateIntact（绝不看 exit code）。",
        }, ensure_ascii=False, indent=2))
        return EXIT_OK
    if not Path(connect).exists():
        raise RunnerError(f"connect.sh 不存在：{connect}（home-connect 未就绪）", EXIT_RUNTIME)
    try:
        proc = subprocess.run(full, capture_output=True, text=True, timeout=args.remote_timeout_seconds)
    except subprocess.TimeoutExpired:
        raise RunnerError("connect.sh mac 超时（守护不可达）→ 停止新增提交", EXIT_STOP)
    stdout = proc.stdout or ""
    # helper status 输出 JSON；从 stdout 提取第一个完整 JSON 对象。
    status_json = _extract_json(stdout)
    if status_json is None:
        raise RunnerError(f"无法从 helper status stdout 解析 JSON（exit={proc.returncode}；不以 exit code 为准）：{stdout[:300]}", EXIT_STOP)
    gate = status_json.get("gate") or {}
    gate_intact = gate.get("gateIntact")
    attestation = {
        "checkedAt": now_iso(),
        "helperStatusSha256": sha256_hex(stdout.encode("utf-8")),
        "gateIntact": gate_intact,
        "fishPid": dig(status_json, "currentFish.pid"),
        "deployCommit": status_json.get("deployCommit"),
        "rawDrawEnabledKey": status_json.get("rawDrawEnabledKey"),
        "configSha256": status_json.get("configSha256"),
        "issues": gate.get("issues", []),
        "gate": {"gateIntact": gate_intact is True, "checks": gate.get("checks", {}), "issues": gate.get("issues", [])},
        "rawStatus": status_json,
    }
    out = Path(args.attestation_out) if getattr(args, "attestation_out", None) else None
    if out:
        atomic_write_json(out, attestation)
    print(json.dumps({"event": "gate_check", "gateIntact": gate_intact is True, "issues": attestation["issues"], "attestationOut": str(out) if out else None}, ensure_ascii=False, indent=2))
    if gate_intact is not True:
        return EXIT_STOP
    return EXIT_OK


def _extract_json(text: str):
    """从可能夹杂日志的 stdout 里提取第一个平衡的 JSON 对象。"""
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        c = text[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start:i + 1])
                except Exception:
                    return None
    return None


def controller_issue_permit(args) -> int:
    pf = Preflight(Path(require(args.preflight, "--preflight")))
    att_path = Path(require(args.gate_attestation, "--gate-attestation（须来自真实 gate-check，不能自造 gateIntact）"))
    attestation = jload(att_path)
    # 新鲜度：attestation 不能太旧（避免拿陈旧 gate 签发许可）。
    checked_at = attestation.get("checkedAt")
    if checked_at:
        try:
            age = (datetime.now().astimezone() - datetime.fromisoformat(checked_at)).total_seconds()
            if age > args.attestation_max_age_seconds:
                raise RunnerError(f"gate attestation 陈旧（{age:.0f}s > {args.attestation_max_age_seconds}s），拒绝签发许可；请重跑 gate-check", EXIT_STOP)
        except ValueError:
            raise RunnerError("gate attestation.checkedAt 不可解析", EXIT_STOP)
    lab_url = getattr(args, "lab_url", None) or pf.lab_url
    batch = {"maxNewJobs": args.max_new_jobs, "maxWallclockSeconds": args.max_wallclock_seconds}
    permit = issue_permit(attestation, lab_url, args.permit_ttl_seconds, batch, pf.experiment_core_commit)
    out = Path(require(args.permit_out, "--permit-out"))
    atomic_write_json(out, permit)
    print(json.dumps({"event": "permit_issued", "path": str(out), "nonce": permit["nonce"], "ttlSeconds": permit["ttlSeconds"], "labUrl": lab_url}, ensure_ascii=False, indent=2))
    return EXIT_OK


def controller_plan_start(args) -> int:
    """从真实 preflight 字段组装 Windows worker 的**独立后台**拉起命令（print-only；
    实际拉起属另派真实冒烟）。镜像 preflight.isolatedInstance.startMethod 的
    Start-Process -WindowStyle Hidden 模式（独立进程树，断 SSH/WSL 会话不被回收）。"""
    pf = Preflight(Path(require(args.preflight, "--preflight")))
    py = pf.windows_python_exe
    runner_win_path = require(args.runner_windows_path, "--runner-windows-path（本脚本在 Windows 上的绝对路径）")
    manifest_win = require(args.manifest_windows_path, "--manifest-windows-path")
    run_root_win = require(args.worker_run_root, "--worker-run-root（Windows 侧绝对 run-root）")
    permit_win = require(args.permit_windows_path, "--permit-windows-path")
    lab_url = getattr(args, "lab_url", None) or pf.lab_url
    arglist = [
        runner_win_path, "worker-run",
        "--manifest", manifest_win,
        "--run-root", run_root_win,
        "--lab-url", lab_url,
        "--permit", permit_win,
    ]
    if args.spec_windows_path:
        arglist += ["--spec", args.spec_windows_path]
    if args.preflight_windows_path:
        arglist += ["--preflight", args.preflight_windows_path]
    if args.max_new_jobs is not None:
        arglist += ["--max-new-jobs", str(args.max_new_jobs)]
    if args.max_wallclock_seconds is not None:
        arglist += ["--max-wallclock-seconds", str(args.max_wallclock_seconds)]
    if args.client_prompt_id_verified:
        arglist += ["--client-prompt-id-verified"]
    # PowerShell Start-Process（-EncodedCommand 由操作者按 preflight.executionChannel.quotingTechnique 生成）
    log_out = f"{run_root_win}/worker.out.log"
    log_err = f"{run_root_win}/worker.err.log"
    ps = (
        "Start-Process -WindowStyle Hidden "
        f"-FilePath '{py}' "
        f"-ArgumentList " + ",".join(f"'{a}'" for a in arglist) + " "
        f"-WorkingDirectory '{run_root_win}' "
        f"-RedirectStandardOutput '{log_out}' -RedirectStandardError '{log_err}' -PassThru"
    )
    print(json.dumps({
        "event": "plan_worker_start_print_only",
        "windowsPython": py,
        "labUrl": lab_url,
        "argumentList": arglist,
        "powershell": ps,
        "relayHint": "经 home-connect connect.sh wsl-relay + PowerShell 绝对互操作路径执行；复杂 PS 用 base64 UTF-16LE -EncodedCommand（见 preflight.isolatedInstance.executionChannel.quotingTechnique）。实际拉起另派，不在本轮。",
        "note": "worker 是独立后台进程，持久化 state/manifest/job/prompt_id，断线不取消已提交作业；用 worker resume 重连。",
    }, ensure_ascii=False, indent=2))
    return EXIT_OK


def controller_run_guard(args) -> int:
    """守护循环：每 --refresh-interval 秒重跑 gate-check + issue-permit（+ 可选推送），
    维持许可新鲜（dead-man switch）。gate 失败/守护不可达即停止刷新 → worker 许可过期停提交。
    print-only 缺省；--execute 才真跑 relay。"""
    pf = Preflight(Path(require(args.preflight, "--preflight")))
    # 统一 attestation 路径：gate-check 写、issue-permit 读同一文件（守护循环内复用）。
    att = getattr(args, "gate_attestation", None) or getattr(args, "attestation_out", None)
    if not att:
        raise RunnerError("controller-run-guard 需 --gate-attestation（gate-check 写 / issue-permit 读 的共享 attestation 路径）", EXIT_USAGE)
    if not getattr(args, "permit_out", None):
        raise RunnerError("controller-run-guard 需 --permit-out（许可输出路径，每轮刷新供推送到 Windows）", EXIT_USAGE)
    args.gate_attestation = att
    args.attestation_out = att
    connect, remote_cmd = build_helper_status_command(pf, args)
    if not args.execute:
        # print-only：描述守护循环计划（不进真实循环——print-only gate-check 不产真实 attestation，
        # 因此无法真签许可；真实循环属 --execute 另派冒烟）。
        print(json.dumps({
            "event": "run_guard_plan_print_only",
            "gateCheckCommand": [connect, "mac", "--", remote_cmd],
            "attestationPath": att,
            "permitOut": args.permit_out,
            "permitTtlSeconds": args.permit_ttl_seconds,
            "refreshIntervalSeconds": args.refresh_interval_seconds,
            "guardIterations": args.guard_iterations,
            "batch": {"maxNewJobs": args.max_new_jobs, "maxWallclockSeconds": args.max_wallclock_seconds},
            "permitPushCommand": args.permit_push_command,
            "note": "每轮：gate-check(解析 gate.gateIntact，不看 exit code) → issue-permit(非 true 拒签) → 可选推送许可到 Windows；gate 失败/守护不可达即停刷新 → worker 许可到期自动停新增提交（accepted 仍回查）。真实循环加 --execute（另派冒烟，本轮不跑）。refresh-interval 应 < permit TTL。",
        }, ensure_ascii=False, indent=2))
        return EXIT_OK
    iterations = args.guard_iterations
    i = 0
    while True:
        i += 1
        try:
            gc = controller_gate_check(args)
        except RunnerError as e:
            print(json.dumps({"event": "guard_stop", "reason": f"gate-check 失败：{e}", "iteration": i}, ensure_ascii=False))
            return e.code
        if gc != EXIT_OK:
            print(json.dumps({"event": "guard_stop", "reason": "gateIntact != true（停止刷新许可 → worker 将过期停提交）", "iteration": i}, ensure_ascii=False))
            return EXIT_STOP
        try:
            controller_issue_permit(args)
        except RunnerError as e:
            print(json.dumps({"event": "guard_stop", "reason": f"issue-permit 失败：{e}", "iteration": i}, ensure_ascii=False))
            return e.code
        if args.execute and args.permit_push_command:
            # 推送许可到 Windows run-root（经既有 relay；小文件，允许）。
            subprocess.run(args.permit_push_command, shell=False, timeout=args.remote_timeout_seconds)
        if iterations is not None and i >= iterations:
            print(json.dumps({"event": "guard_done", "iterations": i}, ensure_ascii=False))
            return EXIT_OK
        time.sleep(args.refresh_interval_seconds)


# ══════════════════════════════════════════════════════════════════════════
# worker 命令装配
# ══════════════════════════════════════════════════════════════════════════
def _load_worker(args):
    manifest_path = Path(require(args.manifest, "--manifest（绝对路径；remote 只消费绝对 manifest）"))
    if not manifest_path.is_absolute():
        manifest_path = manifest_path.resolve()
    if not manifest_path.exists():
        raise RunnerError(f"--manifest 不存在：{manifest_path}（不填假路径）", EXIT_USAGE)
    manifest = Manifest(manifest_path, getattr(args, "expect_schema_version", None))
    run_root = Path(require(args.run_root, "--run-root（Windows 侧绝对 run-root）"))
    if not run_root.is_absolute():
        run_root = run_root.resolve()
    run_root.mkdir(parents=True, exist_ok=True)
    lab_url = require(args.lab_url, "--lab-url（隔离实例 loopback URL，来自 preflight.isolatedInstance.url 或 CLI）")
    # 可选：核 spec/preflight hash 与 manifest 冻结锚一致（给了就严格核）
    if getattr(args, "spec", None):
        sp = Path(args.spec)
        if sp.exists():
            actual = sha256_file(sp)
            if actual != manifest.doc.get("spec_sha256"):
                raise RunnerError(f"spec.json sha256 不符 manifest.spec_sha256（{actual} != {manifest.doc.get('spec_sha256')}）", EXIT_RUNTIME)
    if getattr(args, "preflight", None):
        pp = Path(args.preflight)
        if pp.exists():
            actual = sha256_file(pp)
            if actual != manifest.doc.get("preflight_sha256"):
                raise RunnerError(f"preflight.json sha256 不符 manifest.preflight_sha256（{actual} != {manifest.doc.get('preflight_sha256')}）", EXIT_RUNTIME)
    store = WorkerStore(run_root, manifest, lab_url, new_run=bool(getattr(args, "new_run", False)))
    lab = LabClient(lab_url, args.http_timeout_seconds, args.view_timeout_seconds)
    return manifest, store, lab


def cmd_worker_run(args) -> int:
    if args.max_new_jobs is None and args.max_wallclock_seconds is None:
        raise RunnerError("worker run 必须至少给一个批预算：--max-new-jobs 或 --max-wallclock-seconds（不允许无界跑）", EXIT_USAGE)
    manifest, store, lab = _load_worker(args)
    permit_path = Path(require(args.permit, "--permit（controller 签发并推送到 Windows 的受控提交许可）"))
    permit = PermitGate(permit_path, args.lab_url, store.state)
    worker = Worker(args, manifest, store, permit, lab)
    print(json.dumps({"event": "worker_run_start", "runId": store.state["run_id"], "manifestSha256": manifest.sha256, "jobs": len(manifest.jobs), "labUrl": args.lab_url, "clientPromptIdVerified": worker.client_prompt_id_verified}, ensure_ascii=False, indent=2))
    return worker.run_batch()


def cmd_worker_resume(args) -> int:
    # resume 与 run 同循环；循环开头先推进在途任务（reattach），不重 POST。
    if args.max_new_jobs is None and args.max_wallclock_seconds is None:
        raise RunnerError("worker resume 必须至少给一个批预算：--max-new-jobs 或 --max-wallclock-seconds", EXIT_USAGE)
    manifest, store, lab = _load_worker(args)
    permit_path = Path(require(args.permit, "--permit"))
    permit = PermitGate(permit_path, args.lab_url, store.state)
    worker = Worker(args, manifest, store, permit, lab)
    print(json.dumps({"event": "worker_resume_start", "runId": store.state["run_id"], "openSubmitted": store.open_submitted_job_ids()}, ensure_ascii=False, indent=2))
    return worker.run_batch()


def cmd_worker_status(args) -> int:
    manifest, store, lab = _load_worker(args)
    counts = {}
    for jid, j in store.state["jobs"].items():
        counts[j.get("status", "pending")] = counts.get(j.get("status", "pending"), 0) + 1
    print(json.dumps({
        "event": "worker_status",
        "runId": store.state["run_id"],
        "manifestSha256": manifest.sha256,
        "labUrl": args.lab_url,
        "statusCounts": counts,
        "openSubmittedJobIds": store.open_submitted_job_ids(),
        "stopSchedulingJobIds": store.stop_scheduling_job_ids(),
        "resumePoint": store.state.get("resume_point"),
        "permitLastNonce": store.state.get("permit_last_nonce"),
    }, ensure_ascii=False, indent=2))
    return EXIT_OK


def cmd_worker_closure(args) -> int:
    manifest, store, lab = _load_worker(args)
    return worker_closure(args, manifest, store, lab)


def cmd_worker_plan(args) -> int:
    """纯本地：加载 manifest、拓扑排序、报告调度计划与预算，不发任何网络请求。"""
    manifest_path = Path(require(args.manifest, "--manifest"))
    if not manifest_path.is_absolute():
        manifest_path = manifest_path.resolve()
    manifest = Manifest(manifest_path, getattr(args, "expect_schema_version", None))
    order = manifest.topo_order()
    new_jobs = [j for j in order if manifest.jobs[j]["sample_kind"] == "new"]
    reuse_jobs = [j for j in order if manifest.jobs[j]["sample_kind"] == "reuse"]
    print(json.dumps({
        "event": "worker_plan",
        "manifestSha256": manifest.sha256,
        "schemaVersion": manifest.doc.get("schema_version"),
        "specSha256": manifest.doc.get("spec_sha256"),
        "preflightSha256": manifest.doc.get("preflight_sha256"),
        "totalJobs": len(order),
        "newSampleJobs": len(new_jobs),
        "reuseJobs": len(reuse_jobs),
        "topoOrderHead": order[:20],
        "note": "new 采样行数应 ≤808（§6 上限）；reuse 不 POST。实际 POST 受批预算与许可闸约束。",
    }, ensure_ascii=False, indent=2))
    if len(new_jobs) > 808:
        raise RunnerError(f"manifest new 采样行数 {len(new_jobs)} > 808 上限（§6），拒绝", EXIT_USAGE)
    return EXIT_OK


# ══════════════════════════════════════════════════════════════════════════
# argparse
# ══════════════════════════════════════════════════════════════════════════
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="interaction-study-run.py",
        description="Anima 双人交互探索实验离线 runner（T3b）：controller（Mac 热闸守护/许可签发）+ worker（Windows 隔离实例采样调度）。纯标准库；缺省 print-only；不评审兼容/不构图/不产 patch/不恢复鱼权限。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="详见 var/local-driver/anima-interaction-v1/contracts/runner.md（启停/恢复命令、必需显式输入、待实测协议点）。",
    )
    p.add_argument("--version", action="version", version=RUNNER_VERSION)
    sub = p.add_subparsers(dest="cmd", required=True)

    # ---- worker 公共选项 ----
    def worker_common(sp, need_permit=True, need_caps=True):
        sp.add_argument("--manifest", help="绝对路径 manifest.json（T3a 产出；remote 只消费绝对路径）")
        sp.add_argument("--run-root", dest="run_root", help="Windows 侧绝对 run-root（写 state/results/images/generation-info）")
        sp.add_argument("--lab-url", dest="lab_url", help="隔离实例 loopback URL（preflight.isolatedInstance.url.loopbackReferenceOnly，如 http://127.0.0.1:8189）")
        sp.add_argument("--spec", help="可选：spec.json 路径，给了就核 sha256 与 manifest.spec_sha256 一致")
        sp.add_argument("--preflight", help="可选：preflight.json 路径，给了就核 sha256 与 manifest.preflight_sha256 一致")
        if need_permit:
            sp.add_argument("--permit", help="controller 签发并推送到 Windows 的受控提交许可 JSON（worker 只按新鲜许可工作）")
        if need_caps:
            sp.add_argument("--max-new-jobs", dest="max_new_jobs", type=int, default=None, help="本批最大新任务数（到界不再 POST；不补 seed、不扩 808 预算）")
            sp.add_argument("--max-wallclock-seconds", dest="max_wallclock_seconds", type=int, default=None, help="本批最大墙钟秒（支持 30 分钟真实运行派发预算）")
        sp.add_argument("--job-timeout-seconds", dest="job_timeout_seconds", type=int, default=DEFAULT_JOB_TIMEOUT_S, help=f"单任务 history 观察上限（缺省 {DEFAULT_JOB_TIMEOUT_S}s；超时记 observation_timeout，不伪装取消）")
        sp.add_argument("--poll-interval-seconds", dest="poll_interval_seconds", type=float, default=DEFAULT_POLL_INTERVAL_S, help="history 轮询间隔秒")
        sp.add_argument("--http-timeout-seconds", dest="http_timeout_seconds", type=int, default=DEFAULT_HTTP_TIMEOUT_S, help="HTTP 超时")
        sp.add_argument("--view-timeout-seconds", dest="view_timeout_seconds", type=int, default=DEFAULT_VIEW_TIMEOUT_S, help="/view 与 /upload 超时")
        sp.add_argument("--expect-schema-version", dest="expect_schema_version", default=None, help="可选：强制 manifest.schema_version 等于此值")
        sp.add_argument("--client-prompt-id-verified", dest="client_prompt_id_verified", action="store_true", help="仅在另派冒烟证明服务端以客户端 prompt_id 为键后启用；缺省不假设回显成立")

    sp = sub.add_parser("worker-run", help="worker：按批预算顺序调度采样（一次一个；提交前核许可+隔离队列）")
    worker_common(sp)
    sp.add_argument("--new-run", dest="new_run", action="store_true", help="state.json 属另一 manifest 时归档旧 state 再新建（不覆盖未知旧 run）")
    sp.set_defaults(func=cmd_worker_run)

    sp = sub.add_parser("worker-resume", help="worker：断线重连，用原 prompt_id 推进在途任务，绝不重 POST")
    worker_common(sp)
    sp.set_defaults(func=cmd_worker_resume)

    sp = sub.add_parser("worker-status", help="worker：只读报告 state 概况（无网络 POST）")
    worker_common(sp, need_permit=False, need_caps=False)
    sp.set_defaults(func=cmd_worker_status)

    sp = sub.add_parser("worker-closure", help="worker：全部已提交任务闭合+隔离队列空闲时产 jobs-closed.json（供 G1 另派消费）")
    worker_common(sp, need_permit=False, need_caps=False)
    sp.add_argument("--jobs-closed-out", dest="jobs_closed_out", default=None, help="jobs-closed.json 输出路径（缺省 <run-root>/jobs-closed.json）")
    sp.set_defaults(func=cmd_worker_closure)

    sp = sub.add_parser("worker-plan", help="worker：纯本地报告 manifest 拓扑/预算，不发任何网络请求")
    sp.add_argument("--manifest", help="绝对路径 manifest.json")
    sp.add_argument("--expect-schema-version", dest="expect_schema_version", default=None)
    sp.set_defaults(func=cmd_worker_plan)

    # ---- controller 公共选项 ----
    def controller_common(sp):
        sp.add_argument("--preflight", help="本机（开发 Mac）preflight.json 绝对/相对路径，提供 helper/node/flags/lab 真实字段")
        sp.add_argument("--connect-sh", dest="connect_sh", default=None, help="home-connect connect.sh 路径（缺省 ~/.agents/skills/home-connect/scripts/connect.sh）")
        sp.add_argument("--node-remote", dest="node_remote", default=None, help="覆盖 helper 的 node（缺省取 preflight.gateG0.helper.nodeUsed）")
        sp.add_argument("--helper-remote-path", dest="helper_remote_path", default=None, help="覆盖 helper 远端路径（缺省取 preflight.gateG0.helper.remotePath）")
        sp.add_argument("--helper-flags", dest="helper_flags", default=None, help="覆盖 helper flags（缺省取 preflight.gateG0.helper.flagsEveryCall，须以 status 开头）")
        sp.add_argument("--lab-url", dest="lab_url", default=None, help="隔离 loopback URL（缺省取 preflight.isolatedInstance.url.loopbackReferenceOnly）")
        sp.add_argument("--execute", action="store_true", help="真跑 relay/子进程（缺省 print-only；--execute 属另派真实冒烟，不在本轮）")
        sp.add_argument("--remote-timeout-seconds", dest="remote_timeout_seconds", type=int, default=60, help="connect.sh 调用超时")

    sp = sub.add_parser("controller-gate-check", help="controller：经 connect.sh mac 跑 helper status，解析 gate.gateIntact（不看 exit code）")
    controller_common(sp)
    sp.add_argument("--attestation-out", dest="attestation_out", default=None, help="gate 核验结果 JSON 输出路径（供 issue-permit 消费）")
    sp.set_defaults(func=controller_gate_check)

    sp = sub.add_parser("controller-issue-permit", help="controller：据真实 gate attestation 签发短 TTL 受控提交许可（gateIntact!=true 拒签）")
    controller_common(sp)
    sp.add_argument("--gate-attestation", dest="gate_attestation", help="来自 controller-gate-check 的 attestation JSON（不能自造 gateIntact）")
    sp.add_argument("--attestation-max-age-seconds", dest="attestation_max_age_seconds", type=int, default=120, help="attestation 新鲜度上限")
    sp.add_argument("--permit-out", dest="permit_out", help="许可 JSON 输出路径")
    sp.add_argument("--permit-ttl-seconds", dest="permit_ttl_seconds", type=int, default=DEFAULT_PERMIT_TTL_S, help=f"许可 TTL（缺省 {DEFAULT_PERMIT_TTL_S}s）")
    sp.add_argument("--max-new-jobs", dest="max_new_jobs", type=int, default=None)
    sp.add_argument("--max-wallclock-seconds", dest="max_wallclock_seconds", type=int, default=None)
    sp.set_defaults(func=controller_issue_permit)

    sp = sub.add_parser("controller-plan-start", help="controller：从真实 preflight 组装 Windows worker 独立后台拉起命令（print-only）")
    controller_common(sp)
    sp.add_argument("--runner-windows-path", dest="runner_windows_path", help="本脚本在 Windows 上的绝对路径")
    sp.add_argument("--manifest-windows-path", dest="manifest_windows_path", help="manifest.json 在 Windows 上的绝对路径")
    sp.add_argument("--worker-run-root", dest="worker_run_root", help="Windows 侧绝对 run-root")
    sp.add_argument("--permit-windows-path", dest="permit_windows_path", help="许可 JSON 在 Windows 上的绝对路径")
    sp.add_argument("--spec-windows-path", dest="spec_windows_path", default=None)
    sp.add_argument("--preflight-windows-path", dest="preflight_windows_path", default=None)
    sp.add_argument("--max-new-jobs", dest="max_new_jobs", type=int, default=None)
    sp.add_argument("--max-wallclock-seconds", dest="max_wallclock_seconds", type=int, default=None)
    sp.add_argument("--client-prompt-id-verified", dest="client_prompt_id_verified", action="store_true")
    sp.set_defaults(func=controller_plan_start)

    sp = sub.add_parser("controller-run-guard", help="controller：守护循环，周期 gate-check+issue-permit(+推送) 维持许可新鲜；gate 失败即停刷新")
    controller_common(sp)
    sp.add_argument("--gate-attestation", dest="gate_attestation", help="attestation 输出/复用路径")
    sp.add_argument("--attestation-out", dest="attestation_out", default=None)
    sp.add_argument("--attestation-max-age-seconds", dest="attestation_max_age_seconds", type=int, default=120)
    sp.add_argument("--permit-out", dest="permit_out", help="许可 JSON 输出路径（每轮覆盖，供推送）")
    sp.add_argument("--permit-ttl-seconds", dest="permit_ttl_seconds", type=int, default=DEFAULT_PERMIT_TTL_S)
    sp.add_argument("--max-new-jobs", dest="max_new_jobs", type=int, default=None)
    sp.add_argument("--max-wallclock-seconds", dest="max_wallclock_seconds", type=int, default=None)
    sp.add_argument("--refresh-interval-seconds", dest="refresh_interval_seconds", type=int, default=DEFAULT_REFRESH_INTERVAL_S, help=f"刷新间隔（缺省 {DEFAULT_REFRESH_INTERVAL_S}s，应 < permit TTL）")
    sp.add_argument("--guard-iterations", dest="guard_iterations", type=int, default=None, help="循环次数上限（缺省无限，直到 gate 失败或 Ctrl-C）")
    sp.add_argument("--permit-push-command", dest="permit_push_command", nargs="*", default=None, help="--execute 时把许可推送到 Windows 的命令（经既有 relay；小文件允许）")
    sp.set_defaults(func=controller_run_guard)

    return p


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except RunnerError as e:
        print(json.dumps({"event": "error", "code": e.code, "message": str(e)}, ensure_ascii=False), file=sys.stderr)
        return e.code
    except KeyboardInterrupt:
        print(json.dumps({"event": "interrupted", "note": "worker 已持久化 state；用 worker-resume 重连，不重 POST"}, ensure_ascii=False), file=sys.stderr)
        return EXIT_STOP


if __name__ == "__main__":
    raise SystemExit(main())
