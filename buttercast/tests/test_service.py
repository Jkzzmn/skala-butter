"""Service lab: purchase-timing rules, the paired-bootstrap interval, request validation and (ml) a real continuous run."""
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient

from buttercast.app import create_app
from buttercast.data import RULES
from buttercast.service import (LEVELS, Lab, drift_cause, scores, signal_hit, signal_level, signal_stats, signal_windows, slo_report,
                                wape_gap_interval)


def test_signal_levels_follow_the_forecast_change():
    t = dict(must_buy_pct=4, buy_pct=1.5, wait_pct=-1.5, strong_wait_pct=-4, hold_band_pct=2)
    assert [signal_level(c, t) for c in (6, 4, 2, 1.5, 0, -1.5, -2, -4, -9)] == [
        "must_buy", "must_buy", "buy", "buy", "hold", "wait", "wait", "strong_wait", "strong_wait"]
    assert signal_hit("must_buy", .1, t) and not signal_hit("buy", -.1, t)
    assert signal_hit("strong_wait", -2, t) and not signal_hit("wait", 3, t)
    assert signal_hit("hold", .5, t) and not signal_hit("hold", 5, t)


def test_signal_stats_and_windows_count_hits_against_the_real_move():
    levels = ["must_buy"]*4+["hold"]+["strong_wait"]*3
    predicted = [5, 5, 5, 5, 0, -5, -5, -5]
    realized = [6, 7, -1, 2, 0, -3, -3, 4]
    t = dict(must_buy_pct=4, buy_pct=1.5, wait_pct=-1.5, strong_wait_pct=-4, hold_band_pct=2)
    stats = signal_stats(levels, predicted, realized, t)
    assert stats["must_buy"]["days"] == 4 and stats["must_buy"]["hit"] == 75
    assert stats["strong_wait"]["hit"] == pytest.approx(200/3) and stats["buy"]["hit"] is None
    assert stats["direction_hit"] == pytest.approx(5/7*100)
    windows = signal_windows([f"2024-01-{d:02d}" for d in range(1, 9)], levels, predicted, realized, [True]*8, t)
    assert [(w["level"], w["days"]) for w in windows] == [("must_buy", 4), ("strong_wait", 3)]
    assert set(stats) == {*LEVELS, "direction_hit"}


def test_two_step_trigger_levels():
    from buttercast.service import stage
    assert [stage(v, 4.0, 6.0) for v in (None, 3.9, 4.0, 4.1, 6.0, 6.1, 15)] == [0, 0, 0, 1, 1, 2, 2]


def test_drift_cause_names_what_changed():
    limits = dict(mean_shift=1.0, log_vol=0.5)
    kinds = {k: drift_cause(dict(mean_shift=m, vol_ratio=v), limits)["kind"] for k, (m, v) in dict(
        trend_up=(1.5, 1.0), trend_down=(-1.5, 1.0), vol_up=(0.2, 2.5), vol_down=(0.2, 0.3), trend_vol=(-2, 3), shape=(0.1, 1.1)).items()}
    assert all(name == kind for name, kind in kinds.items()) and drift_cause(None, limits) is None


def test_slo_budget_counts_days_outside_the_warning_limit():
    report = slo_report([1, 2, None, 5, 6, 3, 1, 2, 9, 1, 1], 4.0, .8)
    assert report["days"] == 10 and report["good_days"] == 7 and report["bad_days"] == 3
    assert report["allowed_bad_days"] == pytest.approx(2) and report["budget_left"] == pytest.approx(-1) and report["burn"] == pytest.approx(1.5)
    assert slo_report([None], 4.0, .8) is None


def test_data_quality_faults_are_named_and_notifications_stay_in_the_outbox(tmp_path, monkeypatch):
    monkeypatch.delenv("BUTTERCAST_WEBHOOK_URL", raising=False)
    with TestClient(create_app(tmp_path)) as client:
        lab = Lab(client.app.state.ops)
        rows = [dict(date=f"2024-01-{d:02d}", midpoint=100.0+d, interval_days=1, derived=d % 7 != 0) for d in range(1, 29)]
        official = [i for i, r in enumerate(rows) if not r["derived"]]
        assert lab.quality_issues(rows, 20, official, 7) == []
        rows[20]["midpoint"] = 100.0*3                      # a unit mix-up: three times the price a week ago
        assert [i["kind"] for i in lab.quality_issues(rows, 20, official, 7)] == ["unit"]
        rows[5]["date"] = "2024-01-09"                       # a missing day
        assert "gap" in [i["kind"] for i in lab.quality_issues(rows, 5, official, 7)]
        assert "stale" in [i["kind"] for i in lab.quality_issues(rows[:7], 5, [], 7)]
        record = lab.notify("page", "제목", "내용", job_id="abc", day="2024-01-10")
        assert record["delivery"] == "outbox" and client.get("/api/service/notifications?job_id=abc").json()[0]["title"] == "제목"


def test_a_made_up_shock_changes_only_the_copy_and_is_marked(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        lab = Lab(client.app.state.ops)
        rows = lab.rows()
        shock = dict(start="2024-06-01", days=100, pct=80.0, wave_pct=0.0, wave_days=56)
        shocked = lab.inject(rows, shock)
        first = next(i for i, r in enumerate(rows) if r["date"] >= shock["start"])
        assert [r["midpoint"] for r in shocked[:first]] == [r["midpoint"] for r in rows[:first]]       # nothing before the start moves
        assert shocked[first+shock["days"]-1]["midpoint"] == pytest.approx(rows[first+shock["days"]-1]["midpoint"]*1.8)
        assert shocked[-1]["midpoint"] == pytest.approx(rows[-1]["midpoint"]*1.8)                       # stays at the new level
        assert all(r["synthetic"] and r["injected"] for r in shocked[first:first+shock["days"]]) and not shocked[first+shock["days"]]["injected"]
        assert not any(r["synthetic"] for r in rows)                                                     # the real dataset is untouched
        waved = lab.inject(rows, dict(shock, days=112, wave_pct=15.0))
        assert max(abs(w["midpoint"]/s["midpoint"]-1) for w, s in zip(waved[first:first+112], lab.inject(rows, dict(shock, days=112))[first:first+112])) > .1
        defaults = lab.shock_defaults()
        assert defaults["days"] == lab.config()["ks_reference_days"] and defaults["pct"] > 0 and defaults["wave_pct"] > 0
        with pytest.raises(ValueError):
            lab.validate_shock(dict(shock, start="2020-01-01"), "2024-01-01", "2024-12-31")
        with pytest.raises(ValueError):
            lab.validate_shock(dict(shock, pct=0), "2024-01-01", "2024-12-31")


def test_models_learned_from_made_up_prices_are_not_listed_but_can_start_the_lab(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        base = dict(version="v1", unit="EUR/100kg", interval_days=1, gate=dict(passed=True), validation_passed=True, at="2026-01-01T00:00:00+00:00")
        client.app.state.store.append("models", dict(base, synthetic=False, from_lab="j1", lab_role="baseline"))
        client.app.state.store.append("models", dict(base, version="v2", synthetic=True, from_lab="j1", lab_role="tuned", lab_parent="v1"))
        assert [m["version"] for m in client.get("/api/models").json()["models"]] == ["v1"]          # the Models section: real data only
        assert [m["version"] for m in client.get("/api/service/models").json()] == ["v1", "v2"]    # the lab still offers both
        assert client.post("/api/models/v2/select").status_code == 409


def test_gap_interval_separates_real_improvement_from_noise():
    rng = np.random.default_rng(1)
    actual = 100+rng.normal(0, 1, 140)
    noisy = actual+rng.normal(0, 3, 140)
    better = actual+rng.normal(0, .3, 140)
    low, high = wape_gap_interval(actual, noisy, better)
    assert low > 0 and high >= low
    low, high = wape_gap_interval(actual, noisy, noisy)
    assert low == high == 0
    assert scores([dict(actual=10, x=[[9]])]*3, [11, 11, 11])["direction"] == 100


def test_service_endpoints_refuse_before_a_baseline_exists(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        status = client.get("/api/service/status").json()
        assert status["ready"] is False and status["min_date"] < status["max_date"]
        assert client.get("/api/service/timeline").status_code == 409
        assert client.post("/api/service/replay", json={"date": "2023-01-02"}).status_code == 409
        assert client.post("/api/service/period", json={"start": "2023-01-02", "end": "2023-06-01"}).status_code == 409


@pytest.mark.ml
def test_continuous_run_never_trains_on_the_future_and_scores_both_models(tmp_path):
    def wait(client, job_id):
        deadline = time.monotonic()+600
        while time.monotonic() < deadline:
            job = client.get(f"/api/jobs/{job_id}").json()
            if job["status"] in ("succeeded", "failed", "cancelled"):
                return job
            time.sleep(.2)
        raise TimeoutError(job_id)

    with TestClient(create_app(tmp_path)) as client:
        assert wait(client, client.post("/api/service/baseline", json={"epochs": 10}).json()["id"])["status"] == "succeeded"
        timeline = client.get("/api/service/timeline").json()
        assert timeline["min_date"] > timeline["cutoff"] and len(timeline["dates"]) == len(timeline["wape"])
        cfg = timeline["config"]    # every number comes from the data / model, not from a typed-in constant
        assert timeline["cutoff"] == cfg["baseline_cutoff"] and cfg["ks_reference_days"] == RULES["gate"]["finetune"]["window_weeks"]*7 and cfg["horizon_days"] == 28
        assert 0 < timeline["wape_limit"] < timeline["wape_tune_limit"] and timeline["windows_scored"] >= 20
        sig = timeline["signals"]
        assert sig["strong_wait_pct"] < sig["wait_pct"] < sig["buy_pct"] < sig["must_buy_pct"]
        assert client.post("/api/service/period", json={"start": "2019-01-01", "end": "2019-06-01"}).status_code == 422
        start, end = "2022-09-01", "2023-04-30"
        job = wait(client, client.post("/api/service/period", json={"start": start, "end": end}).json()["id"])
        assert job["status"] == "succeeded", job["error"]
        result = client.get(f"/api/service/replays/{job['id']}").json()
        assert result["metrics"]["fixed"]["n"] == result["metrics"]["adaptive"]["n"] > 200
        for event in result["events"]:   # a fine-tune on day D only ever saw labels known by D
            assert start <= event["day"] <= end and event["trigger"] in ("drift", "wape", "both")
            if event["trigger"] != "drift":
                assert event["wape"] > event["wape_tune_limit"] > event["wape_limit"]
            if event["trigger"] != "wape":    # drift = the latest 60 days differ from the window the serving model learned from
                assert event["ks"] > event["ks_limit"] and event["reference"]["start"] < event["reference"]["end"]
        assert result["series"]["issued_at"][0] == start and result["series"]["issued_at"][-1] == end
        assert all(w["start"] <= w["end"] for w in result["warnings"])   # step 1 alerts, step 2 tunes
        assert set(result["timing"]["adaptive"]["levels"]) <= set(LEVELS)
        live = client.get(f"/api/service/live/{job['id']}").json()    # what the screen follows while the run is going
        days = [row for row in live["rows"] if row["type"] == "day"]
        assert live["done"] and len(days) == len(result["series"]["issued_at"]) and days[0]["day"] == start
        assert [row["type"] for row in live["rows"] if row["type"].startswith("tune")] == ["tune_start", "tune_end"]*len(result["events"])
        assert client.get("/api/service/live/not-a-job!").status_code == 404
        assert client.get(f"/api/service/live/{job['id']}?after={live['total']}").json()["rows"] == []
        for event in result["events"]:     # promotion="shadow": a candidate only replaces the champion after real answers matured
            if event["promoted"]:
                assert event["gate_passed"] and event["shadow"]["passed"] and event["shadow"]["n"] >= result["shadow_days"]
                assert event["decided_on"] > event["day"]
            if event["shadow"] is None:
                assert not event["promoted"]
        assert result["slo"]["fixed"]["target"] == pytest.approx(RULES["service_lab"]["warn_quantile"]*100)
        assert len(result["lineage"]) == len(result["events"]) and all(e["parent"] and e["train_window"] for e in result["lineage"])
        assert client.get(f"/api/service/lineage").json() and client.get(f"/api/service/notifications?job_id={job['id']}").json() is not None
        saved = client.get("/api/models").json()["models"]               # the Models section keeps every lab model
        baseline = next(m for m in saved if m.get("lab_role") == "baseline")
        assert baseline["lab_reference"]["end"] == timeline["cutoff"] and baseline["artifact_health"]["reload_verified"]
        for event in result["events"]:
            if event["decision_metrics"]:                                  # the numbers the decision was taken on are kept
                m = event["decision_metrics"]
                assert m["better"] == (m["challenger"]["wape"] < m["champion"]["wape"] and m["challenger"]["rmse"] < m["champion"]["rmse"])
            if event["promoted"]:
                assert event["decision_metrics"]["better"] and event["registry_version"]
                entry = next(m for m in saved if m["version"] == event["registry_version"])
                assert entry["lab_role"] == "tuned" and entry["lab_decision"] == event["decision_metrics"] and entry["lab_parent"]
                assert not entry["synthetic"]
        assert client.post("/api/service/period", json={"start": start, "end": end, "start_model": "v999"}).status_code == 422
        before = len(client.get("/api/service/replays").json())
        assert before >= 1 and client.get("/api/models").json()["active"] is None   # the lab never touches production
        assert client.post(f"/api/models/{baseline['version']}/select").status_code in (200, 409)   # saved models can be chosen later; 409 only if its own gate failed


def test_a_swap_needs_both_wape_and_rmse_to_improve_and_keeps_the_numbers():
    from buttercast.service import snapshot
    champion = dict(wape=4.0, rmse=50.0, direction=60.0)
    better = snapshot("shadow", 28, champion, dict(wape=3.0, rmse=40.0, direction=70.0))
    assert better["better"] and better["wape_delta"] == pytest.approx(-1.0) and better["rmse_delta"] == pytest.approx(-10.0)
    assert not snapshot("shadow", 28, champion, dict(wape=3.0, rmse=55.0, direction=70.0))["better"]     # WAPE alone is not enough
    assert not snapshot("prescreen", 28, champion, dict(wape=4.5, rmse=40.0, direction=70.0))["better"]
    assert better["basis"] == "shadow" and better["n"] == 28 and better["challenger"]["direction"] == 70.0
