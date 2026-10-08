import asyncio
import fcntl
import logging
import os
import time
import uuid
from contextlib import asynccontextmanager
from datetime import date, timedelta
from pathlib import Path
from typing import Annotated, Literal

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import data, models, service
from .data import RULES
from .metrics import metric, service_summary, stamp
from .operations import Operations
from .pipeline import Pipeline
from .store import Store

STATIC = Path(__file__).parent/"static"
LOGGER = logging.getLogger(__name__)


class TrainRequest(BaseModel):
    epochs: int = Field(20, ge=1, le=100)
    max_seconds: float = Field(300, ge=.1, le=3600)


class RetryRequest(BaseModel):
    max_seconds: float | None = Field(None, ge=.1, le=3600)


class BaselineRequest(BaseModel):
    epochs: int = Field(40, ge=1, le=100)


class ShockRequest(BaseModel):
    start: str = Field(description="가상 충격이 시작되는 날짜")
    days: int = Field(description="가격이 올라가는 기간(일)", ge=7, le=730)
    pct: float = Field(description="그 기간 동안 오르는 비율(%). 예: 80 = 80% 상승", gt=-90, lt=1000)
    wave_pct: float = Field(0, ge=0, lt=200, description="오르는 동안 위아래로 출렁이는 폭(%). 0이면 매끈하게 오르기만 한다")
    wave_days: int = Field(56, ge=7, le=365, description="한 번 출렁이는 데 걸리는 일수")


class PeriodRequest(BaseModel):
    start: str = Field(description="연속 운영을 시작할 날짜 (YYYY-MM-DD)")
    end: str = Field(description="연속 운영을 끝낼 날짜")
    window_weeks: int | None = Field(None, ge=8, le=104, description="파인튜닝 때 쓰는 직전 기간(주). 생략하면 기존 파인튜닝 규칙의 값")
    cooldown_days: int | None = Field(None, ge=7, le=365, description="파인튜닝 사이 최소 간격(일). 생략하면 모니터 창 + 예측 지평")
    promotion: Literal["gate", "shadow", "always"] = Field("shadow", description="gate 사전 검증만 · shadow 사전 검증 + 실제 정답으로 섀도 검증 · always 검증 없이 항상 교체(비교용)")
    pace: float = Field(0, ge=0, le=0.5, description="하루를 진행할 때마다 쉬는 시간(초). 화면에서 흐름을 보려면 0.05 안팎")
    start_model: str | None = Field(None, description="모델 탭에 저장된 서비스 랩 모델(v번호)로 시작. 생략하면 기준 모델")
    shock: ShockRequest | None = Field(None, description="시뮬레이션용 가상 가격 충격. 실제 데이터는 바뀌지 않고, 이 실행 안에서만 가격을 올려서 넣는다")


class ReplayRequest(BaseModel):
    date: str = Field(description="비교 기준 시점 T (YYYY-MM-DD). 이 날짜까지의 데이터만 파인튜닝에 쓴다")
    window_weeks: int = Field(52, ge=8, le=104, description="파인튜닝에 쓰는 T 직전 기간(주)")
    eval_weeks: int = Field(13, ge=4, le=52, description="T 이후 비교 기간(주)")
    force: bool = Field(False, description="기존 모델이 정상이어도 파인튜닝을 실행")


class PredictRequest(BaseModel):
    prices: Annotated[list[Annotated[float, Field(gt=0, allow_inf_nan=False)]],
                      Field(min_length=1, max_length=365)] | None = Field(
        None, description="운영 모델의 입력창과 같은 길이의 연속 가격. 생략하면 현재 데이터셋의 최근 관측 사용")


def recover_all(ops, root):
    """Jobs left `running` by a process that died are marked failed."""
    ops.recover_interrupted()


def worker_status(root):
    beat = root/"worker.heartbeat"
    seen = time.time()-beat.stat().st_mtime if beat.exists() else None
    return dict(alive=seen is not None and seen < 10, last_seen_seconds=seen)


def create_app(root=None, loading_mode=None, job_runner=None):
    # Absolute: MLflow artifact locations are file URIs, which cannot be relative.
    root = Path(root or os.environ.get("BUTTERCAST_RUNTIME") or Path(__file__).resolve().parents[1]/"runtime"/"daily_aiops").resolve()
    loading_mode = loading_mode or os.environ.get("LOADING_MODE", "lazy")
    if loading_mode not in ("lazy", "eager"):
        raise ValueError("LOADING_MODE는 lazy 또는 eager만 허용합니다")
    job_runner = job_runner or os.environ.get("JOB_RUNNER", "thread")
    store = Store(root)
    ops = Operations(store, runner=job_runner)
    pipeline = Pipeline(ops)
    ops.retrain_handler = lambda rows, token: pipeline.submit_train(rows, trigger_id=token)

    async def monitor():
        while True:
            await asyncio.sleep(5)
            try:
                await asyncio.to_thread(ops.collect)
            except Exception as error:
                LOGGER.exception("Metrics collection failed")
                # Health endpoints expose failure; never report stale values as current.
                app.state.collection_error = str(error)
            else:
                app.state.collection_error = None

    @asynccontextmanager
    async def lifespan(app):
        lock = (root/"server.lock").open("a")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            lock.close()
            raise RuntimeError("CSV 저장소는 단일 서버 프로세스만 사용할 수 있습니다") from error
        if not ops.dataset():
            rows = data.bundled_rows()
            store.append("datasets", dict(version=data.version(rows), rows=rows, imported_at=stamp(), source="bundled_audit"))
            ops.event(data.version(rows), "ingest", "succeeded")
        if job_runner == "thread":  # in worker mode the worker owns running jobs and recovers them itself
            recover_all(ops, root)
        app.state.collection_error = None
        if loading_mode == "eager" and ops.active():
            ops.bundle(ops.active())
            ops.log("INFO", f"[eager] model {ops.active()} loaded in {ops.loads[ops.active()]:.3f}s at startup")
        ops.collect()
        ops.event("startup", "monitor", "succeeded")
        app.state.ready_seconds = time.perf_counter()-app.state.created
        task = asyncio.create_task(monitor())
        try:
            yield
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass  # Expected task cancellation during explicit server shutdown.
            ops.executor.shutdown(wait=True)
            fcntl.flock(lock, fcntl.LOCK_UN)
            lock.close()

    app = FastAPI(title="ButterCast", lifespan=lifespan)
    app.state.store, app.state.ops = store, ops
    app.state.created = time.perf_counter()

    @app.middleware("http")
    async def record_request(request: Request, call_next):
        start = time.perf_counter()
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
            return response
        finally:
            path = request.url.path
            category = "lab" if path.startswith("/api/service") else "business" if request.method == "POST" and path.startswith("/api/") else "observation"
            store.append("requests", dict(ts=time.time(), path=path, method=request.method,
                                          category=category, status=status, latency_ms=(time.perf_counter()-start)*1000))

    @app.middleware("http")
    async def no_cache(request: Request, call_next):
        """The screen is plain files: a browser holding an old app.js against a new API is the worst kind of bug to chase."""
        response = await call_next(request)
        if request.url.path == "/" or request.url.path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/")
    def index():
        # ?v= changes whenever a file does, so even a cache that ignores no-store fetches the new script.
        stamp_of = lambda name: int((STATIC/name).stat().st_mtime)    # noqa: E731
        html = (STATIC/"index.html").read_text(encoding="utf-8")
        for name in ("app.js", "style.css"):
            html = html.replace(f"/static/{name}", f"/static/{name}?v={stamp_of(name)}")
        return HTMLResponse(html, headers={"Cache-Control": "no-store"})

    @app.get("/api/health")
    def health():
        active = ops.active()
        return dict(status="collection_error" if app.state.collection_error else "running",
                    error=app.state.collection_error, active_model=active,
                    model_loaded=active in ops.cache, loading_mode=loading_mode,
                    model_load_seconds=ops.loads.get(active), startup_seconds=app.state.ready_seconds,
                    job_runner=job_runner, worker=worker_status(root) if job_runner == "worker" else None)

    @app.get("/api/datasets")
    def datasets():
        ds = ops.dataset()
        return dict(ds, quality=data.quality(ds["rows"]), schema=list(ds["rows"][0]))

    @app.get("/api/metrics/series")
    def metric_series(minutes: int = Query(60, ge=5, le=1440)):
        """Per-minute latency, throughput and 5xx count of business requests (the dashboard's service charts)."""
        now = int(time.time()//60)
        bins = {minute: [] for minute in range(now-minutes+1, now+1)}
        for row in store.read("requests"):
            minute = int(row["ts"]//60)
            if row["category"] == "business" and minute in bins:
                bins[minute].append(row)
        return [dict(minute=minute*60, requests=len(rows), errors=sum(r["status"] >= 500 for r in rows),
                     latency_mean=sum(r["latency_ms"] for r in rows)/len(rows) if rows else None)
                for minute, rows in bins.items()]

    @app.get("/api/metrics")
    def metrics(window: int = Query(300)):
        if window not in (300, 3600, 21600, 86400):
            raise HTTPException(422, "허용 창: 300, 3600, 21600, 86400초")
        snapshot = store.latest("metrics")
        return dict(snapshot, service=service_summary(store.read("requests"), window),
                    collection_error=app.state.collection_error,
                    stale=time.time()-snapshot["ts"] > 15,
                    model_history=[r["scores"] for r in store.read("model_evaluations") if r.get("version") == ops.active()][-60:],
                    history=store.read("metrics")[-60:])

    @app.get("/api/alerts")
    def alerts():
        return list(reversed(store.read("alerts")[-100:]))

    @app.get("/api/jobs")
    def jobs():
        stages = store.read("stages")
        return dict(jobs=[j for j in ops.jobs() if j["kind"] != "simulation"], stages=[r for r in stages if r["stage"] != "simulation"][-100:], stage_states=list({r["stage"]: r for r in stages}.values()))

    @app.get("/api/jobs/{job_id}")
    def job(job_id: str):
        found = next((j for j in ops.jobs() if j["id"] == job_id and j["kind"] != "simulation"), None)
        if found is None:
            raise HTTPException(404, "작업을 찾을 수 없습니다")
        return found

    @app.post("/api/train", status_code=202)
    def train(request: TrainRequest):
        rows = [r for r in ops.dataset()["rows"] if r["available_on"] <= date.today().isoformat()]
        try:
            models.prepare(rows, interval_days=rows[0]["interval_days"])
        except ValueError as error:
            ops.alert("train_preflight", "training", str(error))
            raise HTTPException(422, str(error)) from error
        return pipeline.submit_train(rows, epochs=request.epochs, max_seconds=request.max_seconds)

    @app.post("/api/jobs/{job_id}/retry", status_code=202)
    def retry_job(job_id: str, request: RetryRequest):
        try:
            return pipeline.retry(job_id, request.max_seconds)
        except ValueError as error:
            raise HTTPException(409, str(error)) from error

    @app.post("/api/jobs/{job_id}/cancel", status_code=202)
    def cancel_job(job_id: str):
        try:
            return ops.request_cancel(job_id)
        except ValueError as error:
            raise HTTPException(409, str(error)) from error

    @app.get("/api/models")
    def model_list():
        # Models learned from made-up prices can never serve, so they are not listed here; the service lab keeps them
        # (GET /api/service/models) for use as a starting model.
        return dict(active=ops.active(), models=[m for m in store.read("models") if not m.get("from_experiment") and not m.get("synthetic")],
                    deployments=store.read("deployments"),
                    retrain_candidates=store.read("retrain_candidates"))

    def deploy(version, action):
        """Every refusal is written to aiops.log with its reason, and a swap that the post-deploy check undid is an error."""
        try:
            result = pipeline.deploy(version, action)
        except KeyError as error:
            ops.log("FAIL", f"{action} {version} 거부: 등록된 모델 없음")
            raise HTTPException(404, str(error)) from error
        except ValueError as error:
            ops.log("FAIL", f"{action} {version} 거부: {error}")
            raise HTTPException(409, str(error)) from error
        if result.get("rolled_back"):
            reason = "; ".join(result["rolled_back"])
            raise HTTPException(409, f"{version}은(는) 교체 직후 확인에 실패해 {result['active']}(으)로 되돌렸습니다: {reason}")
        ops.collect()
        return result

    @app.post("/api/models/{version}/select")
    def select(version: str):
        """Serve a gate-passed real-data model; synthetic-future experiment artifacts stay isolated."""
        record = next((row for row in reversed(store.read("models")) if row["version"] == version), None)
        if record is None:
            raise HTTPException(404, f"model {version} not found")
        if record.get("from_experiment"):
            ops.log("FAIL", f"select {version} 거부: 합성 데이터로 만든 시뮬레이션 모델")
            raise HTTPException(409, "시뮬레이션 모델은 합성 미래 데이터를 포함해 운영 모델로 선택할 수 없습니다")
        return deploy(version, "select")

    @app.post("/api/models/{version}/rollback")
    def rollback(version: str):
        return deploy(version, "rollback")

    def serving_bundle(version):
        if version not in ops.cache:
            ops.bundle(version)
            ops.log("INFO", f"[{loading_mode}] model {version} loaded in {ops.loads[version]:.3f}s on first request")
        return ops.cache[version]

    def guarded(version, work):
        """A serving failure of the deployed model (loading its files included) rolls back to the one it replaced,
        then fails this request loudly. Inputs are already validated by Pydantic, so an exception here is the model's."""
        try:
            return work()
        except Exception as error:
            latest = store.latest("deployments")
            if latest["version"] != version or not latest.get("previous") or latest["action"] == "auto_rollback":
                raise
            ops.log("ROLLBACK", f"{version} serving error: {error} → back to {latest['previous']}")
            ops.cache.pop(version, None)
            pipeline.deploy(latest["previous"], "auto_rollback")
            raise HTTPException(503, f"{version} 예측 실패로 {latest['previous']}(으)로 자동 롤백했습니다. "
                                     f"다시 요청하세요: {error}") from error

    def serve(version, prices):
        return guarded(version, lambda: serving_bundle(version).predict(prices))

    def sequence_of(version):
        return guarded(version, lambda: serving_bundle(version).metadata["sequence"])

    @app.post("/api/predict")
    def predict(request: PredictRequest | None = None):
        version = ops.active()
        if request is not None and request.prices is not None:
            # Ad-hoc forecast for a caller-supplied sequence; not stored as an operational prediction.
            required = (sequence_of(version) if version else
                        models.sequence_for(ops.dataset()["rows"][0]["interval_days"]))
            if len(request.prices) != required:
                raise HTTPException(422, f"운영 모델 입력 길이는 연속 가격 {required}개입니다")
        if version is None:
            raise HTTPException(409, "운영 모델이 없습니다. 학습하면 게이트(검증 WAPE)를 통과한 모델이 자동 배포됩니다.")
        if request is not None and request.prices is not None:
            start = time.perf_counter()
            estimates = serve(version, request.prices)
            return dict(version=version, unit=ops.dataset()["rows"][0]["unit"], horizon_days=28, stored=False,
                        inference_ms=(time.perf_counter()-start)*1000, **estimates)
        rows = [r for r in ops.dataset()["rows"] if r["available_on"] <= date.today().isoformat()]
        sequence = sequence_of(version)
        last = rows[-sequence:]
        if len(last) < sequence or any((date.fromisoformat(b["date"])-date.fromisoformat(a["date"])).days != rows[0]["interval_days"] for a, b in zip(last, last[1:])):
            raise HTTPException(422, "최근 입력에 관측 결측 구간이 있습니다")
        target = date.fromisoformat(last[-1]["available_on"])+timedelta(days=28)
        if target <= date.today():
            raise HTTPException(409, "입력이 오래되어 예측 목표일이 이미 지났습니다. 새 데이터를 적재하세요.")
        start = time.perf_counter()
        estimates = serve(version, [r["midpoint"] for r in last])
        result = dict(id=uuid.uuid4().hex[:12], issued_at=stamp(), target_date=target.isoformat(), version=version,
                      data_version=ops.dataset()["version"], horizon_days=28, actual=None, actual_known_at=None,
                      inference_ms=(time.perf_counter()-start)*1000, **estimates)
        store.append("predictions", result)
        ops.event(result["id"], "predict", "succeeded")
        return result

    @app.get("/api/predictions")
    def predictions():
        return store.read("predictions")[-100:]

    @app.get("/api/logs")
    def logs(lines: int = Query(200, ge=1, le=2000)):
        path = root/"aiops.log"
        return path.read_text(encoding="utf-8").splitlines()[-lines:] if path.exists() else []

    lab = service.Lab(ops)

    @app.get("/api/service/status")
    def service_status():
        return lab.status()

    @app.post("/api/service/baseline", status_code=202)
    def service_baseline(request: BaselineRequest):
        rows = lab.rows()
        params = dict(epochs=request.epochs)
        return ops.submit("service_baseline", lambda job_id: lab.train_baseline(job_id, rows, **params),
                          spec=dict(type="service_baseline", dataset_version=ops.dataset()["version"], params=params))

    @app.get("/api/service/timeline")
    def service_timeline():
        try:
            return lab.timeline()
        except FileNotFoundError as error:
            raise HTTPException(409, str(error)) from error

    @app.post("/api/service/replay", status_code=202)
    def service_replay(request: ReplayRequest):
        try:
            lab.validate(request.date, request.eval_weeks)
        except (FileNotFoundError, ValueError) as error:
            raise HTTPException(409 if isinstance(error, FileNotFoundError) else 422, str(error)) from error
        params = dict(day=request.date, window_weeks=request.window_weeks, eval_weeks=request.eval_weeks, force=request.force)
        return ops.submit("service_replay", lambda job_id: lab.replay(job_id, **params),
                          spec=dict(type="service_replay", dataset_version=ops.dataset()["version"], params=params))

    @app.post("/api/service/period", status_code=202)
    def service_period(request: PeriodRequest):
        try:
            lab.validate_period(request.start, request.end)
            if request.shock:
                lab.validate_shock(request.shock.model_dump(), request.start, request.end)
            if request.start_model and not any(m["version"] == request.start_model and m.get("from_lab") for m in store.read("models")):
                raise ValueError(f"{request.start_model}: 서비스 랩에서 저장한 모델이 아닙니다")
        except (FileNotFoundError, ValueError) as error:
            raise HTTPException(409 if isinstance(error, FileNotFoundError) else 422, str(error)) from error
        params = request.model_dump()
        return ops.submit("service_period", lambda job_id: lab.run_period(job_id, **params),
                          spec=dict(type="service_period", dataset_version=ops.dataset()["version"], params=params))

    @app.get("/api/service/live/{job_id}")
    def service_live(job_id: str, after: int = Query(0, ge=0)):
        """Rows the running (or finished) continuous run has produced so far, from row `after` on."""
        if not job_id.isalnum():
            raise HTTPException(404, "작업을 찾을 수 없습니다")
        rows = store.read(f"live_{job_id}")
        return dict(rows=rows[after:], total=len(rows), done=any(r["type"] == "done" for r in rows[-3:]))

    @app.get("/api/service/notifications")
    def service_notifications(job_id: str | None = None, limit: int = Query(200, ge=1, le=1000)):
        rows = store.read("service_notifications")
        return [r for r in reversed(rows) if job_id is None or r.get("job_id") == job_id][:limit]

    @app.get("/api/service/lineage")
    def service_lineage(model: str | None = None):
        rows = store.read("service_lineage")
        return [r for r in reversed(rows) if model is None or r["model"] == model]

    @app.get("/api/service/models")
    def service_models():
        """Every model the lab saved (made-up-data ones included), for the 'start from' choice."""
        return [m for m in store.read("models") if m.get("from_lab")]

    @app.get("/api/service/replays")
    def service_replays():
        return [{k: v for k, v in row.items() if k not in ("series", "log", "weekly", "context", "events", "episodes", "timing", "lineage", "holds", "quality")} for row in reversed(store.read("service_replays"))][:30]

    @app.get("/api/service/replays/{replay_id}")
    def service_replay_result(replay_id: str):
        result = next((row for row in store.read("service_replays") if row["id"] == replay_id), None)
        if result is None:
            raise HTTPException(404, "아직 완료된 결과 없음; 작업 상태를 확인하세요")
        return result

    @app.get("/api/system")
    def system():
        rows = ops.dataset()["rows"]
        interval_days = rows[0]["interval_days"]
        reference_n, current_n = ((180, 30) if interval_days == 1 else (52, 13))
        active = ops.active()
        sequence = (ops.bundle(active).metadata["sequence"] if active else models.sequence_for(interval_days))
        return dict(rules=RULES, job_runner=job_runner, worker=worker_status(root) if job_runner == "worker" else None,
                    storage="CSV · single process", sequence=sequence, interval_days=interval_days, horizon_days=28,
                    loading_mode=loading_mode, features=models.FEATURES,
                    minimum_training_rows=models.MIN_ROWS, model="lstm", model_source="local_bundle + MLflow registry",
                    monitor_interval_seconds=5, reference_observations=reference_n, current_observations=current_n,
                    calibration_windows=20, service=RULES["service"],
                    collection_error=app.state.collection_error, resources=store.latest("metrics")["resources"],
                    uptime=metric(time.time()-app.state.started, "s", 1))

    app.state.started = time.time()
    app.mount("/static", StaticFiles(directory=STATIC), name="static")
    return app
