"""audio-raw/**/*.wav 를 게임에서 쓸 mp3(audio-out/**/*.mp3)로 후처리한다.

처리 순서 (클립마다):
  1) 앞뒤 무음 제거 (앞 0.08초, 뒤 0.15초는 남겨 둔다)
  2) 앞뒤 짧은 페이드 (끝이 뚝 끊기는 클릭 소리 방지)
  3) 2패스 라우드니스 정규화 (기본 -16 LUFS, 트루피크 -1.5 dBTP)
  4) 모노 mp3 인코딩 (기본 96kbps, 샘플레이트는 원본 유지)

ffmpeg, ffprobe가 PATH에 있어야 한다. (Windows: winget install Gyan.FFmpeg)

사용 예:
    python postprocess.py                  # 새로 만들었거나 바뀐 클립만 처리
    python postprocess.py --only nyang/correct
    python postprocess.py --force
    python postprocess.py --lufs -18       # 더 작게

결과: audio-out/<key>.mp3   (key는 script.json의 key와 같다)
      audio-out/_state.json (원본이나 설정이 바뀐 클립만 다시 처리하기 위한 해시)
"""
import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    except FileNotFoundError:  # PATH에 실행 파일이 없을 때
        return subprocess.CompletedProcess(cmd, 127, "", f"{cmd[0]} not found")


def probe(path: Path, entry: str, stream: bool = False) -> str:
    args = ["ffprobe", "-v", "error"]
    if stream:
        args += ["-select_streams", "a:0", "-show_entries", f"stream={entry}"]
    else:
        args += ["-show_entries", f"format={entry}"]
    args += ["-of", "csv=p=0", str(path)]
    return run(args).stdout.strip()


def trim_filters(a) -> str:
    """앞뒤 무음 제거 + 짧은 페이드. areverse로 같은 필터를 뒤쪽에도 적용한다."""
    head = (f"silenceremove=start_periods=1:start_threshold={a.silence_db}dB"
            f":start_silence={a.head_pad}")
    tail = (f"silenceremove=start_periods=1:start_threshold={a.silence_db}dB"
            f":start_silence={a.tail_pad}")
    return (f"{head},areverse,{tail},afade=t=in:d=0.02,areverse,afade=t=in:d=0.005")


def measure_loudness(src: Path, base: str, a) -> dict | None:
    """1패스: 트림한 소리의 라우드니스를 잰다. 측정할 수 없으면 None."""
    cmd = ["ffmpeg", "-hide_banner", "-nostats", "-i", str(src), "-af",
           f"{base},loudnorm=I={a.lufs}:TP={a.tp}:LRA=11:print_format=json",
           "-f", "null", "-"]
    err = run(cmd).stderr
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", err, re.S)
    if not m:
        return None
    data = json.loads(m.group(0))
    if any(str(data[k]).strip("-+").lower() == "inf" for k in ("input_i", "input_thresh")):
        return None
    return data


def process(src: Path, dst: Path, a) -> dict:
    base = trim_filters(a)
    sr = probe(src, "sample_rate", stream=True) or "24000"
    meas = measure_loudness(src, base, a)
    trim_skipped = False
    if meas is None:
        # 무음 기준(--silence-db)보다 소리가 작아 전부 잘려 나갔을 수 있다.
        # 트림 없이 다시 재 보고, 그래도 안 되면 정규화 없이 진행한다.
        base = "anull"
        meas = measure_loudness(src, base, a)
        trim_skipped = True

    if meas:
        norm = (f"loudnorm=I={a.lufs}:TP={a.tp}:LRA=11"
                f":measured_I={meas['input_i']}:measured_TP={meas['input_tp']}"
                f":measured_LRA={meas['input_lra']}:measured_thresh={meas['input_thresh']}"
                f":offset={meas['target_offset']}:linear=true")
        filters = f"{base},{norm}"
    else:
        filters = base  # 너무 짧거나 무음이라 측정 불가: 정규화 없이 진행

    dst.parent.mkdir(parents=True, exist_ok=True)
    # loudnorm은 내부적으로 샘플레이트를 올리므로 -ar로 원래 값으로 되돌린다.
    cmd = ["ffmpeg", "-hide_banner", "-nostats", "-y", "-i", str(src), "-af", filters,
           "-ac", "1", "-ar", sr, "-c:a", "libmp3lame", "-b:a", a.bitrate, str(dst)]
    res = run(cmd)
    if res.returncode != 0:
        raise RuntimeError(res.stderr[-800:])
    return {
        "in_sec": float(probe(src, "duration") or 0),
        "out_sec": float(probe(dst, "duration") or 0),
        "input_i": meas["input_i"] if meas else None,
        "trim_skipped": trim_skipped,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="합성 wav -> 게임용 mp3 후처리")
    ap.add_argument("--in-dir", type=Path, default=Path("audio-raw"))
    ap.add_argument("--out-dir", type=Path, default=Path("audio-out"))
    ap.add_argument("--only", default=None, help="key 접두어 필터 (예: nyang/correct)")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--lufs", type=float, default=-16.0, help="목표 통합 라우드니스")
    ap.add_argument("--tp", type=float, default=-1.5, help="트루피크 상한(dBTP)")
    ap.add_argument("--bitrate", default="96k")
    ap.add_argument("--silence-db", type=float, default=-50.0, help="무음으로 볼 기준(dB)")
    ap.add_argument("--head-pad", type=float, default=0.08, help="앞에 남길 무음(초)")
    ap.add_argument("--tail-pad", type=float, default=0.15, help="뒤에 남길 무음(초)")
    a = ap.parse_args()

    for tool in ("ffmpeg", "ffprobe"):
        if run([tool, "-version"]).returncode != 0:
            print(f"{tool}를 찾을 수 없다. 설치 후에는 PowerShell을 새로 열어야 PATH가 반영된다.\n"
                  f"확인: where.exe {tool}")
            return 2

    sources = sorted(p for p in a.in_dir.rglob("*.wav") if not p.name.startswith("_"))
    jobs = []
    for src in sources:
        key = src.relative_to(a.in_dir).with_suffix("").as_posix()
        if a.only and not key.startswith(a.only):
            continue
        jobs.append((key, src, a.out_dir / f"{key}.mp3"))
    if not jobs:
        print(f"{a.in_dir} 에서 처리할 wav를 찾지 못했다.")
        return 1

    state_path = a.out_dir / "_state.json"
    state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {}
    params = json.dumps([a.lufs, a.tp, a.bitrate, a.silence_db, a.head_pad, a.tail_pad])

    done = skipped = 0
    warnings = []
    for key, src, dst in jobs:
        fp = hashlib.sha1(src.read_bytes() + params.encode()).hexdigest()[:12]
        if not a.force and dst.exists() and state.get(key) == fp:
            skipped += 1
            continue
        try:
            info = process(src, dst, a)
        except RuntimeError as e:
            print(f"[실패] {key}\n{e}")
            return 1
        state[key] = fp
        a.out_dir.mkdir(parents=True, exist_ok=True)
        state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        done += 1
        loud = f"{float(info['input_i']):.1f} LUFS" if info["input_i"] else "측정 불가"
        print(f"{key}: {info['in_sec']:.2f}s -> {info['out_sec']:.2f}s (원본 {loud})")
        if info["trim_skipped"]:
            warnings.append(f"{key}: 무음 제거 결과가 비어 트림을 건너뜀 (--silence-db를 낮춰 보세요)")
        if info["input_i"] is None:
            warnings.append(f"{key}: 라우드니스를 측정하지 못해 정규화를 건너뜀")
        if info["out_sec"] < 0.3:
            warnings.append(f"{key}: 결과가 {info['out_sec']:.2f}초로 너무 짧음 (무음 기준 확인)")
        if info["out_sec"] > 10:
            warnings.append(f"{key}: 결과가 {info['out_sec']:.1f}초로 김")

    print(f"\n처리 {done}개, 건너뜀 {skipped}개 -> {a.out_dir}/")
    for w in warnings:
        print(f"[주의] {w}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
