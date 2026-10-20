# Engine Sound

테슬라 브라우저에서 여는 엔진 소리 페이지입니다.
GPS 속도를 받아 회전수·기어·스로틀을 계산하고, 그에 맞는 엔진 소리를 그 자리에서 합성해 실내 스피커로 냅니다.
녹음 파일은 쓰지 않습니다.

주소: https://hitchoi.github.io/tesla-engine-sound/

## 쓰는 법

1. 차를 세운 상태에서 위 주소를 테슬라 브라우저로 엽니다.
2. 「엔진 시동」을 누르고 위치 권한을 허용합니다.
3. 미디어 볼륨을 올리고 출발합니다.

「시험 주행」으로 바꾸면 차를 움직이지 않고 페달·REV·데모 주행으로 들어 볼 수 있습니다.
맥에서는 ↑(가속), ↓(브레이크), 스페이스(REV)로도 됩니다.

## 차량 13종

Tesla Roadster(냉가스 추진기), Shift Maniac, Porsche 911 GT3, V8 Muscle, Ferrari V12, Dodge Hellcat, ElectricZen, Lamborghini Urus, F1 Slipstream, Ferrari Enzo, Lamborghini Veneno, Audi RS 6 Avant (C8), Porsche Taycan.
차 이름은 어떤 소리를 흉내 냈는지 알려 주는 용도이고, 소리는 모두 이 코드가 합성한 것입니다.

## 구성

| 파일 | 하는 일 |
| --- | --- |
| `dsp.js` | 소리 합성. 점화 순서대로 배기 펄스를 만들고 배기관·머플러·흡기·터보·팝을 더한다. 전기차·타이칸·추진기 소리도 여기 있다 |
| `drive.js` | 속도·가속 → 스로틀 추정, 변속, 회전수, 팝 구간, 터보 압력 |
| `gps.js` | 위치 → 속도·가속(칼만 필터, 정차 흔들림 처리) |
| `presets.js` | 차량별 점화 순서·기어·음색 값 |
| `audio.js`, `worklet.js` | Web Audio 연결. AudioWorklet 이 없으면 ScriptProcessor 로 같은 합성기를 돌린다 |
| `app.js`, `index.html`, `style.css` | 화면 |

## 시험

```bash
node test/render.mjs /tmp/out            # 차마다 데모 주행을 WAV 로 합성하고 레벨·변속·GPS 추정 수치 출력
python3 -m http.server 8765 &            # 페이지 띄우기
python test/browser_check.py http://127.0.0.1:8765/   # 헤드리스 크롬으로 시동·가속·13종·GPS 확인(playwright 필요)
```
