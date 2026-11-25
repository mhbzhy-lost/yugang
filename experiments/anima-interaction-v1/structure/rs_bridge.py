# SPDX-License-Identifier: GPL-3.0-only
"""Locate, sha256-verify and import the FROZEN RS pose3d/mhr geometry modules.

T2a/T2b consume the frozen RS MultiCharacter commit 721d57ab98e80dc6854d4f49758bc9c456bb925c
pose3d scene schema and its CPU rasterizer. This bridge never edits the snapshot, never
downloads, and never falls back to a non-matching file: every consumed byte is sha256-checked
against the frozen digests recorded in preflight.json (productionRsPatch.identicalToFrozen and
assets.mhr_mesh). On any mismatch it raises rather than silently mixing versions.

The three files actually needed for offline structure geometry are pure-numpy:
  pose3d.py  (read_scene / _rasterize / render_pose_condition / project / rotation)
  mhr.py     (asset / global_matrices / mannequin / default_scene)
  web/pose3d/mhr-body.json.gz  (the baked MHR LOD1 adult rig: 127 bones, 54 controls, 4 presets)

mhr.py resolves the asset as Path(__file__).parent/'web/pose3d/mhr-body.json.gz', so the three
are staged into an importable package layout (a staging dir, NOT the snapshot, NOT production).
Stage dir default: env YUGANG_RS_STAGE, else <system temp>/yugang-t2-rsgeom-stage.

License: the staged pose3d.py/mhr.py are GPL-3.0-only (RS package); mhr-body.json.gz is
Apache-2.0 (MHR / Momentum Human Rig, (c) Meta Platforms). MHR-LICENSE.txt / MHR-NOTICE.txt are
copied alongside the staged asset when present at the source. This file only orchestrates copies.
"""
from __future__ import annotations

import gzip
import hashlib
import importlib
import importlib.util
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

# Frozen digests (RS 721d57ab). Sources: preflight.json productionRsPatch.identicalToFrozen,
# assets.mhr_mesh.sha256, and direct shasum of checks/environment-code/rs/* this round.
FROZEN_SHA256 = {
    "pose3d.py": "890fd1cde9eb0b3470ff0222baa086103b329ef75b02be51ab0c668226092cc5",
    "mhr.py": "f7dde006e83daa758a17eaee81f73e2a3c22c0c5700274ce39e162c97153adc0",
    "mhr-body.json.gz": "cc07e6cd297e069781e3b4274aa6267752fc6ac9384fb0f62937da1a469cbf19",
}
FROZEN_RS_COMMIT = "721d57ab98e80dc6854d4f49758bc9c456bb925c"

# This file lives at experiments/anima-interaction-v1/structure/rs_bridge.py
_STRUCTURE_DIR = Path(__file__).resolve().parent
_EXPERIMENT_DIR = _STRUCTURE_DIR.parent
_REPO_ROOT = Path(os.environ.get("YUGANG_ROOT", _EXPERIMENT_DIR.parent.parent))
_RUN_ROOT = _REPO_ROOT / "var" / "local-driver" / "anima-interaction-v1"


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _candidate_source_roots() -> list[Path]:
    """Read-only candidate locations for the frozen RS geometry files, in priority order."""
    roots: list[Path] = []
    env = os.environ.get("YUGANG_RS_SRC")
    if env:
        roots.append(Path(env))
    # T0 extracted the real frozen blobs here (pose3d.py, mhr.py, mhr-body.json.gz all present).
    roots.append(_RUN_ROOT / "checks" / "environment-code" / "rs")
    # The approved-TEMP survey snapshot has pose3d.py/mhr.py but NOT web/pose3d (asset handled separately).
    roots.append(Path(tempfile.gettempdir()) / "comfy-composition-survey-rs-20261111")
    # A real isolated-lab RS install, if T0/T2b provisioned one (has web/pose3d/mhr-body.json.gz).
    env_pkg = os.environ.get("YUGANG_RS_PKG")
    if env_pkg:
        roots.append(Path(env_pkg))
    return roots


def _find_file(name: str, subpath: str | None = None) -> Path:
    """Find one frozen file by basename (optionally under a subdir), sha256-verified."""
    want = FROZEN_SHA256[name]
    tried: list[str] = []
    for root in _candidate_source_roots():
        for cand in ([root / subpath / name] if subpath else []) + [root / name, root / "web" / "pose3d" / name]:
            if cand.is_file():
                tried.append(str(cand))
                got = _sha256(cand)
                if got != want:
                    raise RuntimeError(
                        f"rs_bridge: {cand} sha256 {got} != frozen {want}; refusing to mix versions"
                    )
                return cand
    raise RuntimeError(
        f"rs_bridge: frozen {name} (sha256 {want}) not found. Tried: {tried or _candidate_source_roots()}. "
        f"Set YUGANG_RS_SRC to a dir holding the frozen RS 721d57ab geometry files."
    )


def _stage_dir() -> Path:
    env = os.environ.get("YUGANG_RS_STAGE")
    return Path(env) if env else Path(tempfile.gettempdir()) / "yugang-t2-rsgeom-stage"


_LOADED: dict[str, object] = {}


def load() -> dict[str, object]:
    """Stage + import the frozen geometry package once; return {'pose3d','mhr','asset_meta'}."""
    if _LOADED:
        return _LOADED
    pose3d_src = _find_file("pose3d.py")
    mhr_src = _find_file("mhr.py")
    gz_src = _find_file("mhr-body.json.gz", subpath="web/pose3d")
    stage = _stage_dir()
    pkg = stage / "rsgeom"
    (pkg / "web" / "pose3d").mkdir(parents=True, exist_ok=True)
    shutil.copyfile(pose3d_src, pkg / "pose3d.py")
    shutil.copyfile(mhr_src, pkg / "mhr.py")
    shutil.copyfile(gz_src, pkg / "web" / "pose3d" / "mhr-body.json.gz")
    for lic in ("MHR-LICENSE.txt", "MHR-NOTICE.txt"):
        src = gz_src.parent / lic
        if src.is_file():
            shutil.copyfile(src, pkg / "web" / "pose3d" / lic)
    init = pkg / "__init__.py"
    init.write_text(
        "# Staged frozen RS geometry package (pose3d + mhr only). GPL-3.0-only code; MHR asset Apache-2.0.\n",
        encoding="utf-8",
    )
    # Re-verify staged bytes (defense in depth).
    for rel, key in (("pose3d.py", "pose3d.py"), ("mhr.py", "mhr.py"),
                     ("web/pose3d/mhr-body.json.gz", "mhr-body.json.gz")):
        got = _sha256(pkg / rel)
        if got != FROZEN_SHA256[key]:
            raise RuntimeError(f"rs_bridge: staged {rel} sha256 {got} != frozen {FROZEN_SHA256[key]}")
    if str(stage) not in sys.path:
        sys.path.insert(0, str(stage))
    for mod in ("rsgeom", "rsgeom.pose3d", "rsgeom.mhr"):
        sys.modules.pop(mod, None)
    spec = importlib.util.spec_from_file_location(
        "rsgeom", str(pkg / "__init__.py"), submodule_search_locations=[str(pkg)]
    )
    rsgeom = importlib.util.module_from_spec(spec)
    sys.modules["rsgeom"] = rsgeom
    spec.loader.exec_module(rsgeom)  # type: ignore[union-attr]
    pose3d = importlib.import_module("rsgeom.pose3d")
    mhr = importlib.import_module("rsgeom.mhr")
    with gzip.open(pkg / "web" / "pose3d" / "mhr-body.json.gz", "rt") as f:
        head = json.load(f)
    asset_meta = {
        "rs_commit": FROZEN_RS_COMMIT,
        "pose3d_sha256": FROZEN_SHA256["pose3d.py"],
        "mhr_sha256": FROZEN_SHA256["mhr.py"],
        "mhr_body_gz_sha256": FROZEN_SHA256["mhr-body.json.gz"],
        "bones": len(head["names"]),
        "controls": len(head["controls"]),
        "control_names": sorted(head["controls"].keys()),
        "finger_controls": sorted(k for k in head["controls"] if any(
            f in k for f in ("thumb", "index", "middle", "ring", "pinky"))),
        "presets": sorted(head["presets"].keys()),
        "vertices": len(head["vertices"]) // 3,
        "faces": len(head["faces"]) // 3,
        "source": head.get("source"),
        "staged_from": {"pose3d": str(pose3d_src), "mhr": str(mhr_src), "gz": str(gz_src)},
    }
    _LOADED.update({"pose3d": pose3d, "mhr": mhr, "asset_meta": asset_meta, "asset": mhr.asset})
    return _LOADED


def pose3d():
    return load()["pose3d"]


def mhr():
    return load()["mhr"]


def asset_meta() -> dict:
    return load()["asset_meta"]


if __name__ == "__main__":
    meta = load()["asset_meta"]
    print(json.dumps({k: meta[k] for k in (
        "rs_commit", "pose3d_sha256", "mhr_sha256", "mhr_body_gz_sha256",
        "bones", "controls", "presets", "vertices", "faces", "source")}, indent=2))
    print("finger_controls:", len(meta["finger_controls"]), meta["finger_controls"][:6], "...")
