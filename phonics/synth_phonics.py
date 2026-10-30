#!/usr/bin/env python3
"""
파닉스 단어·사이트 워드 음원 합성 스크립트 — Qwen3-TTS CustomVoice, Speaker: Aiden

단어와 사이트 워드 목록, 음원 경로는 data/stages.json → stageN.json 에서 읽는다(게임과 같은 파일). 어느 폴더에서 실행해도 이 스크립트가 있는 폴더 기준으로 파일이 생긴다.

  audio/words/{word}.mp3          단어 (단계별 목록과 경로는 data/stageN.json 의 words[].audio)
  audio/sight/{word}.mp3          사이트 워드 (sightWords[].audio). 입력 문구는 hint 값("uh", "thuh" 등)을 쓴다
  audio/_raw/words/{word}.wav     후처리 전 원본 wav (후처리 파라미터 조정용)
  audio/_raw/sight/{word}.wav     사이트 워드 원본 wav

음소(audio/phonemes/*.mp3)는 합성하지 않고 직접 만든다. 이 스크립트는 단어와 사이트 워드만 다룬다.
(TTS 는 음소 단독 소리를 안정적으로 만들지 못한다. 철자 "t" 를 넣으면 글자 이름 "티"로 읽는다.)

사용법
  python synth_phonics.py words                # 아직 없는 단어만 합성 (이미 있는 mp3 는 건너뜀)
  python synth_phonics.py words --stage 2      # 2단계 단어와 사이트 워드만
  python synth_phonics.py words --dry-run      # 모델 없이 합성 대상만 출력
  python synth_phonics.py words --only dog,the --seed 7   # 지정한 단어·사이트 워드를 다시 합성 (기존 파일 덮어씀)
  python synth_phonics.py words --force        # 이미 있는 파일도 모두 다시 합성
  python synth_phonics.py check [--stage 2]    # JSON 에 적힌 음원(소리, 단어, 사이트 워드)이 다 있는지 확인

옵션 (words)
  --stage N            해당 단계만 (기본: 정의된 모든 단계)
  --model PATH_OR_ID   로컬 모델 경로 또는 허브 ID (기본: Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice)
  --only sat,sip       일부 단어만 다시 합성 (기존 파일 덮어씀)
  --seed 1234          샘플링 시드. 단어마다 고정 오프셋이 더해져서, 같은 시드면 같은 단어는 거의 같은 결과가 나온다
  --no-instruct        instruct(말투 지시)를 쓰지 않음
  --flash-attn         flash_attention_2 사용 (설치돼 있을 때만)

필요한 것
  pip install -U qwen-tts soundfile numpy
  ffmpeg (mp3 인코딩용, PATH 에 있어야 함)
"""
import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

import numpy as np

# ----------------------------------------------------------------------------
# 설정
# ----------------------------------------------------------------------------
SPEAKER = "Aiden"
LANGUAGE = "English"
DEFAULT_MODEL = "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"

# instruct 는 1.7B CustomVoice 에서 지원된다(0.6B 는 지원하지 않을 수 있음). 효과가 약하면 --no-instruct 로 비교해 본다.
WORD_INSTRUCT = "Say the word slowly and clearly, in a calm, friendly voice, like an English teacher talking to young children. Pronounce the final consonant sound clearly."

WORD_TEXT = "{word}."  # 단어 합성 시 입력 문장. 억양이 어색하면 "{word}" 로 바꿔 본다.

# 특정 단어만 입력 문구를 바꾸고 싶을 때 (예: 끝소리가 약하면 {"sat": "sat!"} 처럼 시도). 사이트 워드도 같은 표를 쓴다.
WORD_TEXT_OVERRIDE = {}

# 단계별 콘텐츠는 코드에 두지 않고 data/stages.json → data/stageN.json 에서 읽는다(게임과 같은 파일).
# 단계를 추가하면 이 스크립트는 수정할 필요가 없다.
ROOT_DEFAULT = Path(__file__).resolve().parent
DATA_DIR = "data"

# 후처리 기본값
TARGET_RMS_DB = -20.0     # 파일 간 음량 통일 목표
PEAK_LIMIT = 0.89         # 약 -1 dBFS
WORD_TRIM_RATIO = 0.004   # 단어용: 약 -48 dB. 단어 끝 /t/ /p/ 의 약한 파열(release)이 잘리지 않도록 낮게 잡는다
WORD_TAIL_MS = 90         # 단어 끝에 남기는 여유

RAW_DIR = "audio/_raw/words"   # 후처리 전 원본 wav (저장소에는 올리지 않음)
RAW_SIGHT_DIR = "audio/_raw/sight"   # 사이트 워드 원본 wav


# ----------------------------------------------------------------------------
# 오디오 후처리 (numpy 만 사용)
# ----------------------------------------------------------------------------
def _frame_rms(x, sr, ms=10):
    n = max(1, int(sr * ms / 1000))
    m = len(x) // n
    if m == 0:
        return np.array([np.sqrt((x ** 2).mean() + 1e-12)]), n
    return np.sqrt((x[: m * n].reshape(m, n) ** 2).mean(axis=1) + 1e-12), n


def find_bounds(x, sr, ratio):
    """앞뒤 무음을 제외한 구간 [start, end) 의 샘플 인덱스. ratio: 최대 진폭 대비 임계 비율."""
    rms, n = _frame_rms(x, sr)
    idx = np.where(rms > rms.max() * ratio)[0]
    if len(idx) == 0:
        return 0, len(x)
    return idx[0] * n, min(len(x), (idx[-1] + 1) * n)


def fade(x, sr, in_ms, out_ms):
    x = x.copy()
    fi = min(len(x), int(sr * in_ms / 1000))
    fo = min(len(x), int(sr * out_ms / 1000))
    if fi > 1:
        x[:fi] *= np.linspace(0.0, 1.0, fi)
    if fo > 1:
        x[-fo:] *= np.linspace(1.0, 0.0, fo)
    return x


def normalize(x):
    rms = np.sqrt((x ** 2).mean() + 1e-12)
    peak = np.abs(x).max() + 1e-12
    gain = min(10 ** (TARGET_RMS_DB / 20) / rms, PEAK_LIMIT / peak)
    return x * gain


def process_word(x, sr):
    s, e = find_bounds(x, sr, WORD_TRIM_RATIO)
    head = int(sr * 0.03)
    tail = int(sr * WORD_TAIL_MS / 1000)
    x = x[max(0, s - head): min(len(x), e + tail)]
    return normalize(fade(x, sr, 5, 40))


# ----------------------------------------------------------------------------
# 파일 입출력 (mp3 는 ffmpeg 로 인코딩)
# ----------------------------------------------------------------------------
def need_ffmpeg():
    if shutil.which("ffmpeg") is None:
        sys.exit("ffmpeg 를 찾을 수 없습니다. mp3 인코딩에 필요합니다. 설치 후 PATH 에 추가하세요.")


def write_wav(path, x, sr):
    import soundfile as sf
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), x, sr)


def write_mp3(path, x, sr):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td) / "tmp.wav"
        write_wav(tmp, x, sr)
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(tmp),
             "-ac", "1", "-codec:a", "libmp3lame", "-q:a", "2", str(path)],
            check=True,
        )


def duration(path):
    if shutil.which("ffprobe") is None:
        return None
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", str(path)],
            capture_output=True, text=True, check=True)
        return float(r.stdout.strip())
    except Exception:
        return None


# ----------------------------------------------------------------------------
# 모델
# ----------------------------------------------------------------------------
def load_model(args):
    import torch
    from qwen_tts import Qwen3TTSModel

    if args.device:
        device = args.device
    elif torch.cuda.is_available():
        device = "cuda:0"
    elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        device = "mps"
    else:
        device = "cpu"
    dtype = torch.bfloat16 if device.startswith("cuda") else torch.float32
    kw = dict(device_map=device, dtype=dtype)
    if args.flash_attn:
        kw["attn_implementation"] = "flash_attention_2"
    print(f"모델 로딩: {args.model} (device={device}, dtype={dtype})")
    return Qwen3TTSModel.from_pretrained(args.model, **kw)


def synth(model, text, instruct, seed):
    import torch
    torch.manual_seed(seed)
    kw = dict(text=text, language=LANGUAGE, speaker=SPEAKER)
    if instruct:
        kw["instruct"] = instruct
    wavs, sr = model.generate_custom_voice(**kw)
    w = wavs[0]
    if hasattr(w, "detach"):
        w = w.detach().float().cpu().numpy()
    return np.asarray(w, dtype=np.float32).reshape(-1), int(sr)


# ----------------------------------------------------------------------------
# 서브커맨드
# ----------------------------------------------------------------------------
def pick_only(items, only):
    if not only:
        return items
    want = {s.strip() for s in only.split(",") if s.strip()}
    unknown = want - set(items)
    if unknown:
        sys.exit(f"알 수 없는 항목: {', '.join(sorted(unknown))}")
    return [i for i in items if i in want]


def load_stages(root):
    """data/stages.json 이 가리키는 단계 파일을 읽어 {단계 번호: 데이터} 로 반환한다."""
    base = Path(root) / DATA_DIR
    try:
        idx = json.loads((base / "stages.json").read_text(encoding="utf-8"))
        stages = [json.loads((base / f).read_text(encoding="utf-8")) for f in idx["stages"]]
    except (OSError, ValueError, KeyError) as e:
        sys.exit(f"데이터를 읽지 못했습니다 ({base}): {e}")
    return {st["stage"]: st for st in stages}


def selected_stages(args, stages):
    if args.stage and args.stage not in stages:
        sys.exit(f"{args.stage}단계가 없습니다. 있는 단계: {', '.join(map(str, sorted(stages)))}")
    return [args.stage] if args.stage else sorted(stages)


def stage_items(stages, nums):
    """{키: {"audio": 음원 경로, "text": 합성 입력 문구, "raw": 원본 wav 경로}} — 단어와 사이트 워드.
    경로는 JSON 의 audio 값(프로젝트 루트 기준). 단계 순서대로, 같은 키는 한 번만 담는다.
    사이트 워드는 철자대로 읽히지 않는 단어가 있어서(a → "에이", the → "디") 글자 대신 hint 를 읽힌다."""
    out = {}
    for n in nums:
        for w in stages[n].get("words", []):
            k = w["word"]
            if k not in out:
                out[k] = {"audio": w["audio"], "raw": f"{RAW_DIR}/{k}.wav",
                          "text": WORD_TEXT_OVERRIDE.get(k, WORD_TEXT.format(word=k))}
        for w in stages[n].get("sightWords", []):
            # 일반 단어와 철자가 같은 사이트 워드(예: is)는 둘 다 만들어야 하므로 키를 "sight:is" 로 구분한다.
            # 단어 목록에 이미 있는 철자일 때만 접두어가 붙고, --only 에도 이 키를 쓴다.
            k = w["word"] if w["word"] not in out else f"sight:{w['word']}"
            if k not in out:
                out[k] = {"audio": w["audio"], "raw": f"{RAW_SIGHT_DIR}/{Path(w['audio']).stem}.wav",
                          "text": WORD_TEXT_OVERRIDE.get(k, WORD_TEXT.format(word=w.get("hint") or w["word"]))}
    return out


def word_seed(base, word):
    """단어마다 고정된 시드 (대상 목록이나 순서가 바뀌어도 같은 단어는 같은 결과)."""
    return base + zlib.crc32(word.encode()) % 100000


def cmd_words(args):
    root = Path(args.root)
    stages = load_stages(root)
    items = stage_items(stages, selected_stages(args, stages))
    words = pick_only(list(items), args.only)
    overwrite = args.force or bool(args.only)
    todo = []
    for w in words:
        if (root / items[w]["audio"]).exists() and not overwrite:
            print(f"  {w:>4}  건너뜀 (이미 있음)")
        else:
            todo.append(w)
    if args.dry_run:
        print(f"합성 대상 {len(todo)}개: {', '.join(todo) if todo else '(없음)'}")
        return
    if not todo:
        print("합성할 단어·사이트 워드가 없습니다. (다시 합성하려면 --only 단어 또는 --force)")
        return
    need_ffmpeg()
    model = load_model(args)
    instruct = None if args.no_instruct else WORD_INSTRUCT
    for w in todo:
        raw, sr = synth(model, items[w]["text"], instruct, word_seed(args.seed, w))
        write_wav(root / items[w]["raw"], raw, sr)
        x = process_word(raw, sr)
        write_mp3(root / items[w]["audio"], x, sr)
        print(f"  {w:>4}  {len(x) / sr:.2f}s")
    print("완료. 모두 귀로 한 번씩 확인하세요. 단어는 끝소리(t, p, d, g)가 들리는지, 사이트 워드는 의도한 발음(a → uh, the → thuh)인지 확인합니다.")


def cmd_check(args):
    """JSON 에 적힌 audio 경로(소리, 단어, 사이트 워드)가 모두 있는지 점검한다."""
    root = Path(args.root)
    stages = load_stages(root)
    total = missing = 0
    for n in selected_stages(args, stages):
        st = stages[n]
        print(f"[{n}단계] {st.get('title', '')}")
        groups = [("소리", st.get("sounds", []), "id"), ("단어", st.get("words", []), "word"),
                  ("사이트 워드", st.get("sightWords", []), "word")]
        seen = set()
        for label, items, key in groups:
            for it in items:
                p = root / it["audio"]
                if p in seen:               # c, k 처럼 한 음원을 공유하는 항목은 한 번만
                    continue
                seen.add(p)
                total += 1
                if p.exists():
                    d = duration(p)
                    print(f"  OK       {it['audio']}" + (f"  ({d:.2f}s)" if d is not None else ""))
                else:
                    missing += 1
                    print(f"  MISSING  {it['audio']}  ({label} {it[key]})")
    print(f"\n{total - missing}/{total} 파일 준비됨")


def main():
    ap = argparse.ArgumentParser(description="파닉스 단어·사이트 워드 음원 합성 (Qwen3-TTS, Aiden)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    pw = sub.add_parser("words", help="단어·사이트 워드 음원 합성")
    pw.add_argument("--stage", type=int, default=None, help="해당 단계만 (기본: data/ 에 정의된 모든 단계)")
    pw.add_argument("--root", default=str(ROOT_DEFAULT), help="프로젝트 루트 (기본: 이 스크립트가 있는 폴더)")
    pw.add_argument("--model", default=DEFAULT_MODEL)
    pw.add_argument("--device", default=None, help="예: cuda:0, mps, cpu (기본: 자동)")
    pw.add_argument("--seed", type=int, default=1234)
    pw.add_argument("--only", default=None, help="쉼표로 구분한 일부 단어·사이트 워드만 (기존 파일 덮어씀)")
    pw.add_argument("--force", action="store_true", help="이미 있는 파일도 다시 합성")
    pw.add_argument("--dry-run", action="store_true", help="모델을 불러오지 않고 합성 대상만 출력")
    pw.add_argument("--no-instruct", action="store_true")
    pw.add_argument("--flash-attn", action="store_true")
    pw.set_defaults(fn=cmd_words)

    pc = sub.add_parser("check", help="필요 파일(소리 + 단어 + 사이트 워드) 점검")
    pc.add_argument("--stage", type=int, default=None, help="해당 단계만 (기본: 모든 단계)")
    pc.add_argument("--root", default=str(ROOT_DEFAULT), help="프로젝트 루트 (기본: 이 스크립트가 있는 폴더)")
    pc.set_defaults(fn=cmd_check)

    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
