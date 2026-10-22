"""음성 합성용 대본(script.json)과 게임용 매니페스트(manifest.json) 생성기.

- 천만냥냥 대사: 게임(index.html)의 `var NY = {...}` 대사 표와 결과 메시지(nyResult)를 직접 읽는다.
  게임의 대사를 고치면 이 스크립트를 다시 실행해 대본을 맞춘다. (대사의 단일 출처는 index.html)
  이름이 들어가는 대사({call}, {name})는 이름을 미리 합성할 수 없으므로 이름 부분을 뺀 문장만 합성한다.
  (예: "{call}! 어서 와냥!" -> 음성은 "어서 와냥!", 말풍선에는 "영희야! 어서 와냥!")
  이름 자리가 문장 맨 앞이 아니면 이름만 빼면 문장이 어색해지므로 합성 대상에서 제외한다.
- 구구단 정답 읽기: INCLUDE_GUGUDAN_ANSWER = True 일 때만 포함한다. 기본값은 False.

사용 (저장소의 tools/voice 폴더에서):
    python build_script.py
    - index.html은 현재 폴더에 있으면 그것을, 없으면 저장소 루트(../../index.html)를 읽는다. 경로를 직접 줄 수도 있다.
    - script.json은 현재 폴더에 만든다. (합성 입력용 중간 파일이라 저장소에는 올리지 않는다)
    - manifest.json은 index.html과 같은 폴더(저장소 루트)에 만든다. 게임이 읽는 파일이라 저장소에 올린다.
"""
import ast
import json
import re
import sys
from pathlib import Path

SINO = {0: "", 1: "일", 2: "이", 3: "삼", 4: "사", 5: "오", 6: "육", 7: "칠", 8: "팔", 9: "구"}


def sino(n: int) -> str:
    """1~99 정수를 한자어 수로 읽는다. (10 -> 십, 12 -> 십이, 21 -> 이십일)"""
    assert 1 <= n <= 99
    tens, ones = divmod(n, 10)
    head = "" if tens == 0 else ("십" if tens == 1 else SINO[tens] + "십")
    return head + SINO[ones]


def gugudan_answer(dan: int, n: int) -> str:
    """전통 구구단 읽기. 곱하는 수가 1이면 '은'이 붙는다. (이 일은 이 / 이 이 사)"""
    product = dan * n
    if n == 1:
        return f"{SINO[dan]} {SINO[n]}은 {sino(product)}"
    return f"{SINO[dan]} {SINO[n]} {sino(product)}"


# 구구단 정답 읽기는 당분간 브라우저 TTS를 그대로 쓰므로 합성 대상에서 뺀다.
INCLUDE_GUGUDAN_ANSWER = False
DAN_RANGE = range(2, 10)   # 2~9단
N_RANGE = range(1, 10)     # x1 ~ x9


def read_game_lines(html_path: Path) -> dict[str, list[str]]:
    """index.html에서 천만냥냥 대사 표(NY)와 결과 메시지를 읽는다. -> {종류: [대사, ...]}"""
    src = html_path.read_text(encoding="utf-8")
    block = re.search(r"var NY = \{(.*?)\n\s*\};", src, re.S)
    if not block:
        raise SystemExit(f"{html_path}에서 'var NY = {{...}}' 를 찾지 못했다")
    lines: dict[str, list[str]] = {}
    for m in re.finditer(r"(\w+)\s*:\s*\[(.*?)\]", block.group(1), re.S):
        lines[m.group(1)] = list(ast.literal_eval("[" + m.group(2) + "]"))
    result = re.search(r"var msg = perfect(.*?);", src, re.S)   # nyResult()의 결과 메시지
    if result:
        lines["result"] = re.findall(r"'([^']*)'", result.group(1))
    return lines


def strip_name(text: str) -> str | None:
    """'{call}! 어서 와냥!' -> '어서 와냥!' 처럼 문장 맨 앞의 이름 자리와 그 뒤 문장부호를 뺀다.
    이름 자리가 문장 맨 앞이 아니거나(예: '오늘은 {name} 차례'), 뺀 뒤 남는 문장이 없으면 None."""
    m = re.match(r"^\{\w+\}[\s!?.,~]*", text)
    if not m:
        return None
    rest = text[m.end():].strip()
    return rest if rest and "{" not in rest else None


def build(html_path: Path) -> list[dict]:
    items = []
    if INCLUDE_GUGUDAN_ANSWER:
        for dan in DAN_RANGE:
            for n in N_RANGE:
                items.append({
                    "key": f"gugudan/a_{dan}x{n}",
                    "group": "gugudan_answer",
                    "text": gugudan_answer(dan, n),
                })
    skipped = []
    for kind, lines in read_game_lines(html_path).items():
        for i, text in enumerate(lines, 1):   # 번호는 원래 순서 기준이라 대사를 뒤에 추가해도 키가 안 바뀐다
            item = {
                "key": f"nyang/{kind}_{i:02d}",
                "group": f"nyang_{kind}",
                "text": text,
            }
            if "{" in text:
                spoken = strip_name(text)
                if spoken is None:
                    skipped.append(text)
                    continue
                # 합성하는 것은 이름을 뺀 문장. 게임이 클립을 찾는 열쇠는 원래 대사(source)다.
                item["text"] = spoken
                item["source"] = text
                print(f"[이름 제외] {text}  ->  {spoken}")
            items.append(item)
    for text in skipped:
        print(f"[제외] 이름 자리가 문장 맨 앞이 아니라 이름만 빼면 문장이 어색해진다: {text}")
    return items


# 버킷(protected-assets) 안의 경로 접두어. 음성을 다시 만들어 올릴 때는 v2로 올리고 여기를 바꾼다.
VOICE_PREFIX = "voice/v1"


def build_manifest(items: list[dict]) -> dict:
    """게임이 읽는 매니페스트. key -> {버킷 경로, 클립을 찾는 대사}.
    이름이 들어가는 대사는 합성한 문장(이름을 뺀 것)이 아니라 index.html의 원래 대사(source)를 열쇠로 쓴다."""
    return {
        x["key"]: {"path": f"{VOICE_PREFIX}/{x['key']}.mp3", "text": x.get("source", x["text"])}
        for x in items
    }


if __name__ == "__main__":
    if len(sys.argv) > 1:
        html = Path(sys.argv[1])
    else:
        html = Path("index.html")
        if not html.exists():
            html = Path(__file__).resolve().parent.parent.parent / "index.html"   # tools/voice -> 저장소 루트
    if not html.exists():
        raise SystemExit(f"{html}을 찾을 수 없다. 게임의 index.html 경로를 인자로 주세요.")
    items = build(html)
    manifest_path = html.resolve().parent / "manifest.json"
    with open("script.json", "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(build_manifest(items), f, ensure_ascii=False, indent=2)
    print(f"{len(items)}개 항목을 저장했다: script.json, {manifest_path}")
