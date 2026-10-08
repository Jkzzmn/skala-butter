# ButterCast — 버터 가격 예측 AIOps 시뮬레이터

EU 버터 가격(일별, EUR/100kg)을 4주 뒤까지 예측하는 LSTM 모델을 **운영하면서 계속 감시하고, 이상이 생기면 스스로 고치는** AIOps 루프를 보여 주는 프로젝트입니다.
(A small AIOps playground: serve an LSTM price forecaster, watch its error and input drift, fine-tune it when it degrades, and replace it only when it is provably better.)

화면 하나로 모든 것을 볼 수 있습니다: 데이터가 들어오고 → 예측하고 → 드리프트를 확인하고 → 경고(1단계) → 파인튜닝(2단계) → 검증 → 모델 교체.

## 무엇이 들어 있나

| 구성 | 내용 |
|---|---|
| 서빙 | FastAPI 예측 API, 요청 지연·에러율 지표, 교체 직후 자동 롤백 |
| MLOps | 학습 → 게이트 → 자동 배포, MLflow 레지스트리(`@production`), 모델 롤백/선택 |
| 서비스 랩 | 과거 구간을 하루씩 재생하며 감시·파인튜닝·교체를 시뮬레이션하고, 기준 모델과 WAPE/RMSE로 비교 |
| 드리프트 감시 | 서비스 모델이 학습한 윈도우 vs 최근 데이터(KS) · 오차 WAPE · 데이터 품질 점검 |
| 안전장치 | 사전 검증 → 섀도 운영(실제 정답으로 검증) → 두 지표(WAPE·RMSE)가 모두 좋아질 때만 자동 교체 |
| 구매 타이밍 | 예측 변화율로 매일 5단계 신호(무조건 구매 ~ 강한 대기)와 적중률 |
| 운영 | SLO/에러 버짓, 알림함(웹훅 선택), 모델 계보(감사 기록) |
| 가상 충격 | 시계열 중간에 가상의 급등 구간을 넣어, 파인튜닝 모델이 추가되는 장면을 확인 (실제 데이터는 바뀌지 않음) |

## 바로 실행하기

필요한 것: **Python 3.11 ~ 3.13**, 인터넷(처음 한 번 TensorFlow 설치, 약 수백 MB).

```bash
git clone https://github.com/Jkzzmn/skala-butter.git
cd skala-butter/buttercast

python3 -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -e '.[ml,dev]'

uvicorn buttercast.app:create_app --factory --port 8000
```

브라우저에서 http://localhost:8000 을 엽니다. 데이터(`buttercast/data/`)는 저장소에 들어 있어 따로 받을 것이 없습니다.
상태(학습된 모델, 로그, MLflow DB)는 `buttercast/runtime/`에 만들어지며 git에는 올라가지 않습니다.

### 처음 써 보는 순서

1. **서비스** 탭 → "기준 모델 학습"을 한 번 누릅니다 (약 10~30초).
2. **연속 자동 운영** → "드리프트 모두 포함" → "이 구간 연속 운영 실행". 라이브로 감시·파인튜닝·교체가 진행됩니다.
3. "가상 충격 데이터 넣기"를 체크하고 실행하면 모델이 교체되는 장면이 뚜렷하게 보입니다.
4. 결과의 **파인튜닝 기록** 탭에서 교체한 순간의 WAPE/RMSE와 교체 후 실제 성과를 확인합니다.
5. **모델** 탭에서 저장된 모델을 운영에 올리거나 되돌릴 수 있습니다 (가상 데이터로 학습한 모델은 목록에 나타나지 않습니다).

## 테스트

```bash
cd buttercast
pytest                      # 빠른 테스트 (TensorFlow 학습 없음, 수 초)
pytest -m "ml or not ml"    # 실제 LSTM 학습을 포함한 전체 (약 2~3분)
```

## Docker

```bash
cd buttercast
docker compose up --build   # http://127.0.0.1:8091  (API + 학습 워커 2개 컨테이너)
```

## 설정 (환경변수)

| 이름 | 기본값 | 설명 |
|---|---|---|
| `BUTTERCAST_RUNTIME` | `buttercast/runtime/daily_aiops` | 상태 저장 폴더 |
| `LOADING_MODE` | `lazy` | `lazy`(첫 요청 때) / `eager`(시작 때) 모델 로딩 |
| `JOB_RUNNER` | `thread` | `worker`면 별도 프로세스(`python -m buttercast.worker`)가 학습을 실행 |
| `BUTTERCAST_WEBHOOK_URL` | (없음) | 지정하면 알림을 그 주소로 전송. 없으면 화면의 알림함에만 기록 |

판단 기준(게이트, 경고 분위수 등)은 [`buttercast/buttercast/rules.json`](buttercast/buttercast/rules.json)에 모여 있습니다.
서비스 랩의 경계값과 윈도우 길이는 직접 정한 숫자가 아니라 데이터와 모델에서 계산됩니다 (`GET /api/service/status`의 `config`).

## 폴더 구조

```
buttercast/
  buttercast/          앱 코드 (app.py API · service.py 서비스 랩 · models.py LSTM · monitoring.py 드리프트 · pipeline.py 배포)
  buttercast/static/   화면 (index.html · app.js · style.css, 빌드 단계 없음)
  data/                EU 버터 가격 (주간 · 일별)
  tests/               pytest
  Dockerfile, docker-compose.yml, pyproject.toml
```

## 데이터

`buttercast/data/`의 가격은 European Commission, Milk Market Observatory의 EU 버터 주간 가격에서 가져왔고,
일별 시리즈는 주간 값을 선형 보간해 만든 것입니다 (파일의 `metadata`에 출처 URL과 방법이 있습니다).
재사용 조건은 원 출처의 약관을 확인하세요.

## 알아 둘 점

- 학습·교육용 프로젝트입니다. 구매 신호나 경계값은 가정에 기반한 시연용이며 실제 구매 판단에 쓰기 위한 것이 아닙니다.
- 이 데이터에서는 파인튜닝한 모델이 기준 모델보다 낫다는 근거가 약한 구간이 많습니다. 화면은 그 결과를 그대로 보여 줍니다.
- "가상 충격 데이터"는 시뮬레이션 안에서만 쓰이는 만든 값이며, 그로 학습한 모델은 운영에 올릴 수 없습니다.
