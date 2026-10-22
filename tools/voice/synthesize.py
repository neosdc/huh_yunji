"""script.json을 읽어 보이스 클론(Qwen3-TTS Base)으로 클립을 합성한다. (로컬 PC, GPU)

clone_voice.py와 같은 폴더에 두고 실행한다. 참조 음원 전처리, Whisper 자동 받아쓰기,
모델 로딩은 clone_voice.py의 함수를 그대로 가져다 쓴다.

사용 예 (PowerShell, .venv312 활성화 상태):

  # 0) 무엇을 만들지만 확인 (모델 로딩 없음)
  python synthesize.py --ref audio_vocals.mp3 --ref-text "참조 음원에서 말한 내용" --dry-run

  # 1) 시험 삼아 3개만 (ICL 모드, 권장)
  python synthesize.py --ref audio_vocals.mp3 --ref-text "참조 음원에서 말한 내용" --limit 3

  # 2) 전부 (이미 만든 클립은 건너뜀)
  python synthesize.py --ref audio_vocals.mp3 --ref-text "참조 음원에서 말한 내용"

  # 일부만 / 전부 다시 / 음색만 복제(x-vector)
  python synthesize.py --ref ... --ref-text ... --only nyang_correct
  python synthesize.py --ref ... --ref-text ... --force
  python synthesize.py --ref audio_vocals.mp3 --xvector

결과: audio-raw/<key>.wav        (예: audio-raw/nyang/correct_01.wav)
      audio-raw/_ref_processed.wav  (전처리된 참조 음원, 확인용)
      audio-raw/_state.json      (대본, 모델, 참조 음원, 시드가 바뀐 클립만 다시 만들기 위한 해시)
"""
import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

RAW_DIR = Path("audio-raw")
STATE_PATH = RAW_DIR / "_state.json"


def file_sha1(path: Path) -> str:
    return hashlib.sha1(path.read_bytes()).hexdigest()[:12]


def fingerprint(item: dict, args, ref_mode: str, ref_hash: str) -> str:
    """이 값이 같으면 같은 결과가 나온다고 보고 재생성을 건너뛴다."""
    raw = json.dumps(
        [item["text"], args.model, args.language, ref_hash, ref_mode,
         args.max_ref_sec, args.seed],
        ensure_ascii=False,
    ).encode("utf-8")
    return hashlib.sha1(raw).hexdigest()[:12]


def main() -> int:
    ap = argparse.ArgumentParser(description="script.json 일괄 보이스 클론 합성")
    ap.add_argument("--script", default="script.json")
    ap.add_argument("--only", default=None, help="group 접두어 필터 (nyang, nyang_correct 등)")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--force", action="store_true", help="이미 만든 클립도 다시 생성")
    ap.add_argument("--dry-run", action="store_true", help="생성할 목록만 출력하고 종료")

    # clone_voice.py와 같은 옵션
    ap.add_argument("--ref", required=True, type=Path, help="참조 음원 (mp3/wav 등)")
    ap.add_argument("--ref-text", default=None, help="참조 음원의 정확한 트랜스크립트")
    ap.add_argument("--auto-ref-text", action="store_true", help="Whisper로 ref-text 자동 생성")
    ap.add_argument("--ref-lang", default=None, help="Whisper 언어 코드 (예: ko)")
    ap.add_argument("--whisper-model", default="large-v3")
    ap.add_argument("--xvector", action="store_true", help="x-vector 전용 모드 (ref-text 불필요)")
    ap.add_argument("--max-ref-sec", type=float, default=None, help="참조 음원 앞부분만 사용")
    ap.add_argument("--language", default="Korean")
    ap.add_argument("--model", default="Qwen/Qwen3-TTS-12Hz-1.7B-Base")
    ap.add_argument("--attn", default="sdpa", help="sdpa | eager | flash_attention_2")
    ap.add_argument("--seed", type=int, default=1234)
    args = ap.parse_args()

    if not args.ref.exists():
        print(f"참조 음원을 찾을 수 없다: {args.ref}")
        return 2
    if not args.xvector and not (args.ref_text or args.auto_ref_text):
        print("ICL 모드에는 --ref-text 또는 --auto-ref-text가 필요하다 (아니면 --xvector).")
        return 2

    items = json.loads(Path(args.script).read_text(encoding="utf-8"))
    if args.only:
        items = [x for x in items if x["group"].startswith(args.only)]

    ref_mode = "xvector" if args.xvector else (args.ref_text or "auto")
    ref_hash = file_sha1(args.ref)

    RAW_DIR.mkdir(exist_ok=True)
    state = json.loads(STATE_PATH.read_text(encoding="utf-8")) if STATE_PATH.exists() else {}

    todo = []
    for item in items:
        out = RAW_DIR / f"{item['key']}.wav"
        fp = fingerprint(item, args, ref_mode, ref_hash)
        if not args.force and out.exists() and state.get(item["key"]) == fp:
            continue
        todo.append((item, out, fp))
    if args.limit is not None:
        todo = todo[: args.limit]

    print(f"대상 {len(items)}개 중 생성 필요 {len(todo)}개")
    if args.dry_run:
        for item, out, _ in todo:
            print(f"  {item['key']}  <-  {item['text']}")
        return 0
    if not todo:
        return 0

    # 무거운 import는 실제로 합성할 때만 한다 (--help, --dry-run을 빠르게 하기 위해)
    import numpy as np
    import soundfile as sf
    import torch
    from clone_voice import TARGET_SR, load_model, load_reference, transcribe

    wave = load_reference(args.ref, args.max_ref_sec)
    sf.write(str(RAW_DIR / "_ref_processed.wav"), wave, TARGET_SR)
    print(f"[ref] {len(wave) / TARGET_SR:.2f}s, 24kHz mono")

    ref_text = args.ref_text
    if not args.xvector and not ref_text:
        ref_text = transcribe(wave, args.ref_lang, args.whisper_model)
        print(f"[ref-text] {ref_text}\n  -> 실제 발화와 다르면 --ref-text로 직접 지정하세요.")
        if not ref_text:
            print("받아쓰기 결과가 비어 있다. --ref-text로 직접 지정하세요.")
            return 2

    model = load_model(args.model, args.attn)
    prompt = model.create_voice_clone_prompt(
        ref_audio=(wave, TARGET_SR),
        ref_text=None if args.xvector else ref_text,
        x_vector_only_mode=args.xvector,
    )

    for i, (item, out, fp) in enumerate(todo, 1):
        out.parent.mkdir(parents=True, exist_ok=True)
        # 클립마다 같은 시드로 시작해, 한 클립만 다시 만들어도 순서와 무관하게 재현된다.
        torch.manual_seed(args.seed)
        t0 = time.perf_counter()
        wavs, out_sr = model.generate_voice_clone(
            text=item["text"], language=args.language, voice_clone_prompt=prompt
        )
        torch.cuda.synchronize()
        dt = time.perf_counter() - t0
        audio = np.asarray(wavs[0], dtype=np.float32)
        sf.write(str(out), audio, out_sr)
        state[item["key"]] = fp
        STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[{i}/{len(todo)}] {dt:.1f}s, 오디오 {len(audio) / out_sr:.1f}s | "
              f"{item['key']}  <-  {item['text']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
