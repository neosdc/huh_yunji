# 천만냥냥 음성 만들기

천만냥냥 대사의 음성 파일을 만드는 도구입니다. 게임은 이 도구가 만든 mp3를 Supabase 비공개 버킷에서 내려받아 재생합니다(루트 README의 "천만냥냥 음성" 참고).

**참조 음원과 합성한 음성(wav, mp3)은 이 저장소에 올리지 않습니다.** 저작권이 있고 저장소가 공개이기 때문에 `.gitignore`로 막아 두었습니다. 올라가는 것은 스크립트와 이 문서뿐입니다.

## 파일

| 파일 | 하는 일 |
| --- | --- |
| `build_script.py` | `index.html`의 천만냥냥 대사 표(`NY`)와 결과 메시지를 읽어 합성 대본 `script.json`과 게임이 읽는 `../../manifest.json`을 만듭니다. 이름이 들어가는 대사(`{call}`, `{name}`)는 이름을 미리 합성할 수 없으므로 **이름 부분을 뺀 문장만** 합성하고(예: "{call}! 어서 와냥!" → "어서 와냥!"), 매니페스트에는 원래 대사를 조회 키로 남깁니다. 이름 자리가 문장 맨 앞이 아닌 대사는 제외합니다. |
| `synthesize.py` | `script.json`의 대사를 Qwen3-TTS(Base 모델)의 보이스 클론으로 합성해 `audio-raw/<key>.wav`로 저장합니다. 이미 만든 클립은 건너뜁니다. |
| `clone_voice.py` | 참조 음원 전처리, Whisper 받아쓰기, 모델 로딩 함수를 제공합니다(`synthesize.py`가 가져다 씁니다). 단독으로도 한 문장을 합성해 볼 수 있습니다. |
| `postprocess.py` | `audio-raw/**/*.wav`를 무음 제거, 페이드, 라우드니스 정규화(-16 LUFS)를 거쳐 모노 mp3 `audio-out/<key>.mp3`로 만듭니다. |

## 준비

- Python 3.12, NVIDIA GPU(CUDA), 그리고 `torch`, `qwen_tts`, `soundfile`, `numpy`, `scipy`
- `ffmpeg`, `ffprobe` (PATH에 있어야 하며, 설치한 뒤에는 터미널을 새로 열어야 합니다)
- 참조 음원: 합성할 목소리의 음원 파일과 그 음원에서 말한 **정확한 문장**. 본인의 목소리이거나 사용 동의를 받은 목소리여야 합니다. 음원 파일은 `tools/voice/` 안에 두어도 `.gitignore`가 막아 줍니다.

## 순서

`tools/voice` 폴더에서 실행합니다.

```powershell
# 1) 대본과 매니페스트 만들기 (index.html의 대사가 기준)
python build_script.py

# 2) 합성: 먼저 3개만 만들어 들어 보고, 이상이 없으면 전부
python synthesize.py --ref audio_vocals.mp3 --ref-text "참조 음원에서 말한 내용" --limit 3
python synthesize.py --ref audio_vocals.mp3 --ref-text "참조 음원에서 말한 내용"

# 3) 후처리: audio-raw의 wav -> audio-out의 mp3
python postprocess.py

# 4) audio-out/nyang 의 mp3를 직접 몇 개 들어 본다 (postprocess가 [주의]를 낸 클립은 꼭)
```

5. **업로드:** Supabase 대시보드 Storage의 `protected-assets` 버킷 `voice/v1/nyang/` 아래에 `audio-out/nyang`의 mp3를 올립니다.
6. **배포:** `build_script.py`가 갱신한 `manifest.json`을 커밋해 머지합니다.

## 알아둘 점

- **대사를 바꿀 때:** `index.html`의 `NY` 대사 표나 결과 메시지를 고치면, 1번부터 다시 실행합니다. 키는 대사의 순서 번호(`ok_01`, `bad_02` …)로 만들어지므로, 대사를 중간에 끼워 넣으면 뒤쪽 번호가 밀립니다. 새 대사는 맨 뒤에 추가하는 것이 안전합니다. `synthesize.py`는 대본, 모델, 참조 음원, 시드가 바뀐 클립만 다시 만듭니다.
- **음성을 다시 만들 때(같은 대사라도):** 같은 경로에 덮어쓰면 이미 받아 둔 기기가 옛 음성을 계속 씁니다. `build_script.py`의 `VOICE_PREFIX`를 `voice/v2`로 바꾸고, 새 폴더에 올린 뒤 `manifest.json`을 갱신하세요.
- **이름이 들어가는 인사의 음성:** 말풍선에는 "영희야! 어서 와냥! …"처럼 이름이 붙지만 음성은 "어서 와냥! …"만 나옵니다. 매니페스트를 먼저 배포하고 음성 파일을 나중에 올리면 그동안 그 인사는 소리 없이 지나가므로(게임은 정상 동작), 새 클립은 **업로드를 먼저 하고 머지**하세요.
- **마음에 들지 않는 클립만 다시:** `--seed`를 바꾸거나 `--only <group 접두어>`, `--force`를 씁니다. 그룹은 `nyang_ok`, `nyang_bad`, `nyang_slow`, `nyang_hi`, `nyang_result` 입니다.
- **아주 짧은 대사**("좋냥", "맞냥", "자냥")는 합성이 불안정하거나 음량 측정이 안 될 수 있습니다. 후처리가 `[주의]`를 내면 직접 들어 보세요.
- **참조 음원 받아쓰기:** `--auto-ref-text`는 받아쓰기가 틀리면 복제 품질이 떨어지므로 정확한 `--ref-text`를 직접 주는 것을 권합니다.
- **구구단 정답 읽기**(예: "이 일은 이")는 지금은 브라우저 TTS를 씁니다. 음성 파일로 바꾸려면 `build_script.py`의 `INCLUDE_GUGUDAN_ANSWER`를 `True`로 바꿉니다.
