#!/usr/bin/env python3
"""Incrementally copy completed study PNGs and their mechanical evidence via home-connect."""
import argparse
import base64
import datetime
import hashlib
import json
import os
import pathlib
import shlex
import subprocess
import tarfile
import tempfile
import time
import uuid

REMOTE_RUN = os.environ.get("YUGANG_REMOTE_RUN", "/mnt/c/Users/<win-user>/yugang-anima-interaction-run-20261111-e970eb55/anima-interaction-v1/stages/full-execution-v4")
EXPECTED_MANIFEST = "a07406fe9afe5c050bbe85742742b010bc317e1c9915840df0d8da61fda32e10"
CONNECT = pathlib.Path.home() / ".agents/skills/home-connect/scripts/connect.sh"
ROUTE = "wsl"
INDEX_TITLE = "Anima 2B 双人交互：实时回收"
INDEX_DESCRIPTION = "DC = DeepSeek/Claude；QG = Qwen/Grok。HAND/HUG/KISS/CARRY = 牵手/拥抱/接吻/背负。W/M/C/XU/XH = 远景/中景/近景/上半身超近景/头部边界。"
REMOTE = r'''
import pathlib,json,hashlib,tarfile,io
r=pathlib.Path(RUN)
raw=(r/"manifest.json").read_bytes()
assert hashlib.sha256(raw).hexdigest()==EXPECTED
m=json.loads(raw); s=json.loads((r/"state.json").read_text()); added=[]
files={}
for j in m["jobs"]:
    jid=j["job_id"]; st=s["jobs"].get(jid,{})
    if st.get("status")!="success" or jid in KNOWN: continue
    images=[]
    for nid,win in st["outputs"]["files"].items():
        w=pathlib.PureWindowsPath(win)
        src=pathlib.Path("/mnt")/w.drive[0].lower()/pathlib.Path(*w.parts[1:])
        assert src.resolve().is_relative_to(r.resolve()), str(src)
        blob=src.read_bytes(); sha=hashlib.sha256(blob).hexdigest()
        assert sha==st["outputs"]["hashes"][nid], jid
        rel=f"images/{j['group']}/{jid}.png" if len(st["outputs"]["files"])==1 else f"images/{j['group']}/{jid}__{nid}.png"
        files[rel]=blob; images.append({"path":rel,"sha256":sha,"bytes":len(blob)})
    files[f"parameters/{jid}.json"]=(json.dumps({"job":j,"execution":st,"local_images":images,"visual_review":"user_only"},ensure_ascii=False,indent=2)+"\n").encode()
    files[f"graphs/{jid}.json"]=(r/j["graph_path"]).read_bytes()
    for name,condition in j.get("condition_files",{}).items():
        source=(r/condition["path"]).resolve()
        assert source.is_relative_to(r.resolve()) and pathlib.PurePosixPath(name).name==name
        blob=source.read_bytes()
        assert hashlib.sha256(blob).hexdigest()==condition["sha256"]
        files[f"conditions/{j['case_id']}/{name}"]=blob
    for p in (r/"generation-info").glob(jid+"*"):
        if p.is_file():files["generation-info/"+p.name]=p.read_bytes()
    added.append(jid)
if added:
    path=pathlib.Path.home()/"t3f-staging"/("interaction-live-"+BATCH+".tgz")
    with tarfile.open(path,"x:gz") as t:
        for rel,blob in files.items():
            ti=tarfile.TarInfo(rel);ti.size=len(blob);ti.mode=0o644
            t.addfile(ti,io.BytesIO(blob))
    print(json.dumps({"batch":BATCH,"archive":str(path),"sha256":hashlib.sha256(path.read_bytes()).hexdigest(),"jobs":added,"files":{k:hashlib.sha256(v).hexdigest() for k,v in files.items()}}))
else:print(json.dumps({"batch":BATCH,"jobs":[]}))
'''


def connect(*args):
    return subprocess.run([str(CONNECT), ROUTE, *args], check=True, capture_output=True, text=True, timeout=180).stdout


def write_new(path, blob):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if path.read_bytes() != blob:
            raise RuntimeError(f"refusing to overwrite different bytes: {path}")
        return
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".pull-", delete=False) as f:
        temp = pathlib.Path(f.name)
        f.write(blob)
    try:
        path.hardlink_to(temp)
    finally:
        temp.unlink(missing_ok=True)


def pull(dest, temp_root):
    ledger = temp_root / "received-jobs.json"
    if ledger.exists():
        saved = json.loads(ledger.read_text())
        if saved["destination"] != str(dest):
            raise RuntimeError("receipt ledger belongs to a different destination")
        known = saved["jobs"]
    else:
        known = sorted(p.stem for p in (dest / "parameters").glob("*.json"))
        ledger.write_text(json.dumps({"destination": str(dest), "jobs": known}) + "\n")
    batch = uuid.uuid4().hex
    code = "RUN=" + repr(REMOTE_RUN) + "\nEXPECTED=" + repr(EXPECTED_MANIFEST) + "\nKNOWN=" + repr(known) + "\nBATCH=" + repr(batch) + "\n" + REMOTE
    encoded = base64.b64encode(code.encode()).decode()
    receipt = json.loads(connect("sh", "printf %s " + shlex.quote(encoded) + " | base64 -d | python3"))
    if not receipt["jobs"]:
        return 0
    archive = temp_root / (batch + ".tgz")
    connect("get", receipt["archive"], str(archive))
    if hashlib.sha256(archive.read_bytes()).hexdigest() != receipt["sha256"]:
        raise RuntimeError("archive SHA-256 mismatch")
    # Write images/evidence first and parameters last, so known means complete.
    with tarfile.open(archive) as t:
        members = sorted(t.getmembers(), key=lambda x: x.name.startswith("parameters/"))
        for member in members:
            rel = pathlib.PurePosixPath(member.name)
            if not member.isfile() or rel.is_absolute() or ".." in rel.parts or member.name not in receipt["files"]:
                raise RuntimeError("unsafe or unregistered archive member")
            blob = t.extractfile(member).read()
            if hashlib.sha256(blob).hexdigest() != receipt["files"][member.name]:
                raise RuntimeError("member SHA-256 mismatch")
            write_new(dest / member.name, blob)
    receipt["received_at"] = datetime.datetime.now().astimezone().isoformat()
    write_new(dest / "receipts" / (batch + ".json"), (json.dumps(receipt, ensure_ascii=False, indent=2) + "\n").encode())
    next_ledger = ledger.with_suffix(".tmp")
    next_ledger.write_text(json.dumps({"destination": str(dest), "jobs": sorted(set(known) | set(receipt["jobs"]))}) + "\n")
    next_ledger.replace(ledger)
    rows = [json.loads(p.read_text()) for p in sorted((dest / "parameters").glob("*.json"))]
    index = ["# " + INDEX_TITLE, "", f"已回收 **{len(rows)}** 项；更新于 {receipt['received_at']}。", "", "这是增量交付，不代表完整实验已完成。图像效果仅由主人 review；助手未评分或选优。", "", INDEX_DESCRIPTION, "图片按方法组存放；参数、原 graph、条件与 generation-info 同时回收。", "", "|任务|图片|参数|", "|---|---|---|"]
    for row in rows:
        jid = row["job"]["job_id"]
        links = " / ".join(f"[PNG]({x['path']})" for x in row["local_images"])
        index.append(f"|{jid}|{links}|[JSON](parameters/{jid}.json)|")
    (dest / "INDEX.md").write_text("\n".join(index) + "\n")
    archive.unlink()
    connect("sh", "rm -- " + shlex.quote(receipt["archive"]))
    print(json.dumps({"event": "images_pulled", "new": len(receipt["jobs"]), "total": len(rows), "directory": str(dest), "at": receipt["received_at"]}, ensure_ascii=False), flush=True)
    return len(receipt["jobs"])


def main():
    global REMOTE_RUN, EXPECTED_MANIFEST, ROUTE, INDEX_TITLE, INDEX_DESCRIPTION
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--destination", type=pathlib.Path)
    p.add_argument("--temp-root", type=pathlib.Path)
    p.add_argument("--profile", type=pathlib.Path, help="Explicit immutable stage, identity, destination and route")
    p.add_argument("--watch", action="store_true")
    p.add_argument("--interval", type=int, default=15)
    p.add_argument("--remote-run", help="Explicit owned stage directory; requires --manifest-sha256")
    p.add_argument("--manifest-sha256", help="Frozen manifest identity for the explicit stage")
    p.add_argument("--route", choices=("wsl", "wsl-relay"))
    p.add_argument("--fail-streak-limit", type=int, default=0,
                   help="watch 模式连续传输失败上限；达到后大声退出(exit 3)，缺省 0=无限重试(旧行为)")
    a = p.parse_args()
    if a.profile:
        profile = json.loads(a.profile.read_text())
        allowed = {"remote_run", "manifest_sha256", "destination", "temp_root", "route", "title", "description"}
        if not isinstance(profile, dict) or set(profile) - allowed:
            p.error("profile has unknown fields")
        for key in ("remote_run", "manifest_sha256", "destination", "temp_root", "route"):
            if getattr(a, key) is not None and key in profile and str(getattr(a, key)) != profile[key]:
                p.error("explicit argument conflicts with profile: " + key)
            if key in profile:
                setattr(a, key, pathlib.Path(profile[key]) if key in ("destination", "temp_root") else profile[key])
        INDEX_TITLE = profile.get("title", INDEX_TITLE)
        INDEX_DESCRIPTION = profile.get("description", INDEX_DESCRIPTION)
    if a.destination is None or a.temp_root is None:
        p.error("destination and temp-root are required, explicitly or in --profile")
    if a.route not in (None, "wsl", "wsl-relay"):
        p.error("profile route must be wsl or wsl-relay")
    if bool(a.remote_run) != bool(a.manifest_sha256):
        p.error("--remote-run and --manifest-sha256 must be supplied together")
    if a.remote_run:
        stage = pathlib.PurePosixPath(a.remote_run)
        owned_stages = pathlib.PurePosixPath(REMOTE_RUN).parent
        if not stage.is_relative_to(owned_stages) or stage == owned_stages or ".." in stage.parts:
            p.error("explicit run must be an owned study stage directory")
        if len(a.manifest_sha256) != 64 or any(c not in "0123456789abcdef" for c in a.manifest_sha256):
            p.error("manifest SHA-256 must be 64 lowercase hexadecimal characters")
        REMOTE_RUN, EXPECTED_MANIFEST = str(stage), a.manifest_sha256
    ROUTE = a.route or "wsl"
    if (a.temp_root / "received-jobs.json").exists() and not (a.destination / "live-study.json").exists():
        raise RuntimeError("delivery directory was removed; refusing to recreate reviewed/deleted files")
    a.destination.mkdir(parents=True, exist_ok=True)
    a.temp_root.mkdir(parents=True, exist_ok=True)
    marker = a.destination / "live-study.json"
    identity = {"source": REMOTE_RUN, "manifest_sha256": EXPECTED_MANIFEST, "not_final_delivery": True}
    write_new(marker, (json.dumps(identity, indent=2) + "\n").encode())
    streak = 0
    while True:
        try:
            pull(a.destination, a.temp_root)
            streak = 0
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
            if not a.watch:
                raise
            streak += 1
            print(json.dumps({"event": "transfer_unavailable", "streak": streak, "error": str(e)[:300]}), flush=True)
            if a.fail_streak_limit and streak >= a.fail_streak_limit:
                print(json.dumps({"event": "transfer_fail_streak_exceeded", "streak": streak,
                                  "limit": a.fail_streak_limit,
                                  "hint": "relay/channel or remote helper broken; investigate, do not assume GPU problem"}), flush=True)
                raise SystemExit(3)
        if not a.watch:
            break
        time.sleep(max(5, a.interval))


if __name__ == "__main__":
    main()
