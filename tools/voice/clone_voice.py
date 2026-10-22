#!/usr/bin/env python
"""Qwen3-TTS (Base 모델) 보이스 클론 스크립트.

사용 예 (PowerShell, .venv312 활성화 상태):

  # 1) 전처리만 실행해서 참조 음원 상태 확인
  python clone_voice.py --ref audio_vocals.mp3 --prep-only

  # 2) 트랜스크립트를 직접 지정 (ICL 모드, 권장)
  python clone_voice.py --ref audio_vocals.mp3 --ref-text "참조 음원에서 말한 내용" ^
      --text "합성할 문장입니다." --language Korean --out out.wav

  # 3) 트랜스크립트 없이 화자 임베딩만 사용 (x-vector 모드, 음색만 복제)
  python clone_voice.py --ref audio_vocals.mp3 --xvector --text "합성할 문장입니다." --language Korean

  # 4) Whisper로 트랜스크립트 자동 생성 후 사용 (pip install faster-whisper 필요)
  python clone_voice.py --ref audio_vocals.mp3 --auto-ref-text --ref-lang ko --text-file script.txt
"""
import argparse
import re
import sys
import time
from math import gcd
from pathlib import Path

import numpy as np
import soundfile as sf

TARGET_SR = 24000


def load_reference(path: Path, max_sec: float | None) -> np.ndarray:
    """오디오를 읽어 mono / 24kHz / 피크 -3 dBFS로 정규화한다."""
    data, sr = sf.read(str(path), always_2d=True, dtype="float32")
    mono = data.mean(axis=1)
    if sr != TARGET_SR:
        from scipy.signal import resample_poly

        g = gcd(sr, TARGET_SR)
        mono = resample_poly(mono, TARGET_SR // g, sr // g).astype(np.float32)
    if max_sec:
        mono = mono[: int(max_sec * TARGET_SR)]
    mono = mono - mono.mean()  # DC 오프셋 제거
    peak = float(np.abs(mono).max())
    if peak > 0:
        mono = mono * (10 ** (-3 / 20) / peak)
    return mono.astype(np.float32)


def transcribe(wave_24k: np.ndarray, lang: str | None, model_size: str) -> str:
    """faster-whisper로 참조 음원 트랜스크립트를 만든다 (CPU int8, 짧은 클립용)."""
    from faster_whisper import WhisperModel
    from scipy.signal import resample_poly

    wave_16k = resample_poly(wave_24k, 2, 3).astype(np.float32)  # 24k -> 16k
    wm = WhisperModel(model_size, device="cpu", compute_type="int8")
    segments, info = wm.transcribe(wave_16k, language=lang, beam_size=5)
    text = " ".join(s.text.strip() for s in segments).strip()
    print(f"[whisper] language={info.language} prob={info.language_probability:.2f}")
    return text


def split_text(text: str, max_chars: int) -> list[str]:
    """문장 단위로 나눈 뒤 max_chars 이하로 이웃 문장을 병합한다."""
    sentences = [s.strip() for s in re.split(r"(?<=[.!?。！？…])\s+|\n+", text.strip()) if s.strip()]
    chunks: list[str] = []
    buf = ""
    for s in sentences:
        if buf and len(buf) + 1 + len(s) > max_chars:
            chunks.append(buf)
            buf = s
        else:
            buf = f"{buf} {s}".strip()
    if buf:
        chunks.append(buf)
    return chunks


def load_model(name: str, attn: str):
    import torch
    from qwen_tts import Qwen3TTSModel

    kwargs = dict(device_map="cuda:0", dtype=torch.bfloat16)
    try:
        return Qwen3TTSModel.from_pretrained(name, attn_implementation=attn, **kwargs)
    except Exception as e:  # attn 구현이 지원되지 않는 환경 대비
        print(f"[warn] attn_implementation={attn} 실패({e!r}), 기본값으로 재시도")
        return Qwen3TTSModel.from_pretrained(name, **kwargs)


def main() -> int:
    ap = argparse.ArgumentParser(description="Qwen3-TTS voice clone")
    ap.add_argument("--ref", required=True, type=Path, help="참조 음원 (mp3/wav 등)")
    ap.add_argument("--ref-text", default=None, help="참조 음원의 정확한 트랜스크립트")
    ap.add_argument("--auto-ref-text", action="store_true", help="Whisper로 ref-text 자동 생성")
    ap.add_argument("--ref-lang", default=None, help="Whisper 언어 코드 (예: ko, en, ja)")
    ap.add_argument("--whisper-model", default="large-v3")
    ap.add_argument("--xvector", action="store_true", help="x-vector 전용 모드 (ref-text 불필요)")
    ap.add_argument("--max-ref-sec", type=float, default=None, help="참조 음원 앞부분만 사용")
    ap.add_argument("--prep-only", action="store_true", help="전처리 결과만 저장하고 종료")
    ap.add_argument("--text", default=None)
    ap.add_argument("--text-file", type=Path, default=None)
    ap.add_argument("--language", default="Korean", help="합성 언어: Korean/English/Japanese/Chinese/Auto ...")
    ap.add_argument("--model", default="Qwen/Qwen3-TTS-12Hz-1.7B-Base")
    ap.add_argument("--attn", default="sdpa", help="sdpa | eager | flash_attention_2")
    ap.add_argument("--max-chars", type=int, default=120, help="한 번에 합성할 최대 글자 수")
    ap.add_argument("--gap", type=float, default=0.4, help="청크 사이 무음(초)")
    ap.add_argument("--seed", type=int, default=1234)
    ap.add_argument("--out", type=Path, default=Path("clone_out.wav"))
    args = ap.parse_args()

    wave = load_reference(args.ref, args.max_ref_sec)
    ref_out = args.out.with_name(args.out.stem + "_ref_processed.wav")
    sf.write(str(ref_out), wave, TARGET_SR)
    print(f"[ref] {len(wave) / TARGET_SR:.2f}s, 24kHz mono, 저장: {ref_out}")
    if args.prep_only:
        return 0

    ref_text = args.ref_text
    if not args.xvector:
        if args.auto_ref_text:
            ref_text = transcribe(wave, args.ref_lang, args.whisper_model)
            print(f"[ref-text] {ref_text}\n  -> 실제 발화와 다르면 --ref-text로 직접 지정하세요.")
        if not ref_text:
            print("ICL 모드에는 --ref-text 또는 --auto-ref-text가 필요합니다 (아니면 --xvector).")
            return 2

    text = args.text or (args.text_file.read_text(encoding="utf-8") if args.text_file else None)
    if not text:
        print("--text 또는 --text-file이 필요합니다.")
        return 2
    chunks = split_text(text, args.max_chars)

    import torch

    torch.manual_seed(args.seed)
    model = load_model(args.model, args.attn)
    prompt = model.create_voice_clone_prompt(
        ref_audio=(wave, TARGET_SR),
        ref_text=None if args.xvector else ref_text,
        x_vector_only_mode=args.xvector,
    )

    pieces: list[np.ndarray] = []
    out_sr = None
    total = 0.0
    for i, chunk in enumerate(chunks, 1):
        torch.cuda.synchronize()
        t0 = time.perf_counter()
        wavs, out_sr = model.generate_voice_clone(
            text=chunk, language=args.language, voice_clone_prompt=prompt
        )
        torch.cuda.synchronize()
        dt = time.perf_counter() - t0
        audio = np.asarray(wavs[0], dtype=np.float32)
        dur = len(audio) / out_sr
        total += dur
        print(f"[{i}/{len(chunks)}] {dt:.1f}s 소요, 오디오 {dur:.1f}s, RTF={dt / dur:.2f} | {chunk[:40]}")
        pieces.append(audio)
        if i < len(chunks):
            pieces.append(np.zeros(int(args.gap * out_sr), dtype=np.float32))

    sf.write(str(args.out), np.concatenate(pieces), out_sr)
    print(f"완료: {args.out} (총 {total:.1f}s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
