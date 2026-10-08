"""Service lab: pick a point in time T on the real price history, judge the baseline model there, fine-tune it on
the weeks before T when it is doing badly, and compare both models on the real prices after T.

Nothing here is injected or made up: the baseline only ever saw data up to its cutoff, the fine-tune only sees
rows up to T, and the comparison uses forecasts issued after T against prices that really happened.
"""
import bisect
import json
import math
import os
import shutil
import time
import urllib.request
from datetime import date, timedelta

import numpy as np
from scipy.stats import ks_2samp

from . import models
from .data import RULES, version
from .metrics import accuracy, stamp
from .monitoring import calibrate, performance_window
from .pipeline import Pipeline

DAILY = 1
HORIZON_DAYS = 28    # models.train_bundle forecasts price[t+28d]; every window below is expressed in multiples of it


def scores(samples, predicted):
    """WAPE / RMSE / bias / 4-week direction of one model on the same forecasts."""
    actual = np.asarray([s["actual"] for s in samples], dtype=float)
    last = np.asarray([s["x"][-1][0] for s in samples], dtype=float)
    predicted = np.asarray(predicted, dtype=float)
    base = accuracy(actual, predicted)
    return dict(n=len(actual), wape=base["wape"]["value"], rmse=base["rmse"]["value"],
                rmse_pct=base["rmse"]["value"]/float(actual.mean())*100, bias=base["bias"]["value"],
                direction=float(np.mean(np.sign(predicted-last) == np.sign(actual-last))*100))


def wape_gap_interval(actual, base, tuned, block=7, resamples=1000, seed=42):
    """95% interval of WAPE(base) − WAPE(tuned) with weekly blocks (daily errors are strongly autocorrelated)."""
    actual = np.asarray(actual)
    base_error, tuned_error = np.abs(actual-np.asarray(base)), np.abs(actual-np.asarray(tuned))
    blocks = [np.arange(i, min(i+block, len(actual))) for i in range(0, len(actual), block)]
    rng, gaps = np.random.default_rng(seed), []
    for _ in range(resamples):
        index = np.concatenate([blocks[j] for j in rng.integers(0, len(blocks), len(blocks))])
        gaps.append((base_error[index].sum()-tuned_error[index].sum())/actual[index].sum()*100)
    return [float(np.quantile(gaps, .025)), float(np.quantile(gaps, .975))]


LEVELS = ("must_buy", "buy", "hold", "wait", "strong_wait")


def lagged_returns(prices, lag):
    """`lag`-day log return that ENDS at each row (NaN for the first `lag` rows)."""
    result = np.full(len(prices), np.nan)
    result[lag:] = np.log(prices[lag:]/prices[:-lag])
    return result


def window_stats(returns, reference, end, current_days):
    """How the latest `current_days` returns differ from the window a model learned from: KS distance, the shift of the
    mean in units of the reference's own spread, and the ratio of the spreads."""
    ref, cur = returns[reference[0]:reference[1]+1], returns[end-current_days+1:end+1]
    ref, cur = ref[np.isfinite(ref)], cur[np.isfinite(cur)]
    if len(ref) < 30 or len(cur) < 30:
        return None
    spread = float(ref.std())
    return dict(ks=float(ks_2samp(ref, cur).statistic), mean_shift=float((cur.mean()-ref.mean())/spread) if spread > 0 else 0.0,
                vol_ratio=float(cur.std()/spread) if spread > 0 else 1.0)


def window_ks(returns, reference, end, current_days):
    stats = window_stats(returns, reference, end, current_days)
    return stats["ks"] if stats else None


def drift_cause(stats, limits):
    """What kind of change is it? Both limits are 95th percentiles of the same statistic on the baseline's own calm history."""
    if stats is None:
        return None
    shifted = abs(stats["mean_shift"]) > limits["mean_shift"]
    volatile = stats["vol_ratio"] > 0 and abs(math.log(stats["vol_ratio"])) > limits["log_vol"]
    up = stats["mean_shift"] > 0
    kind = ("trend_vol" if shifted and volatile else ("trend_up" if up else "trend_down") if shifted else
            ("vol_up" if stats["vol_ratio"] > 1 else "vol_down") if volatile else "shape")
    return dict(kind=kind, mean_shift=stats["mean_shift"], vol_ratio=stats["vol_ratio"], direction="up" if up else "down", limits=limits)


def slo_report(wape_values, limit, target):
    """Share of days the model stayed inside the warning limit, against a target, and what is left of the error budget."""
    values = [v for v in wape_values if v is not None]
    if not values:
        return None
    good = sum(v <= limit for v in values)
    allowed = (1-target)*len(values)
    return dict(target=target*100, days=len(values), good_days=good, bad_days=len(values)-good, attainment=good/len(values)*100,
                allowed_bad_days=allowed, budget_left=allowed-(len(values)-good), burn=(len(values)-good)/allowed if allowed else None)


def snapshot(basis, n, champion, challenger):
    """The numbers a model was replaced on, kept at the moment of the decision. A candidate counts as better only when BOTH
    WAPE and RMSE are lower - a lower WAPE alone can hide a few large misses, which is what RMSE punishes."""
    return dict(basis=basis, n=n, champion=champion, challenger=challenger, wape_delta=challenger["wape"]-champion["wape"],
                rmse_delta=challenger["rmse"]-champion["rmse"], direction_delta=challenger["direction"]-champion["direction"],
                better=bool(challenger["wape"] < champion["wape"] and challenger["rmse"] < champion["rmse"]))


def stage(wape, warn_limit, tune_limit):
    """0 normal, 1 warning only, 2 fine-tune. Both limits are quantiles of the baseline's own out-of-sample 28-day WAPE."""
    if wape is None or wape <= warn_limit:
        return 0
    return 2 if wape > tune_limit else 1


def signal_level(change, t):
    """Purchase timing from the 4-week forecast change in %, against thresholds computed from the model's own forecasts."""
    return ("must_buy" if change >= t["must_buy_pct"] else "buy" if change >= t["buy_pct"] else
            "hold" if change > t["wait_pct"] else "wait" if change > t["strong_wait_pct"] else "strong_wait")


def signal_hit(level, realized, t):
    """Did the price do what the signal said? Buy-side: it rose. Wait-side: it fell. Hold: it moved less than a typical month."""
    if level in ("must_buy", "buy"):
        return realized > 0
    if level in ("wait", "strong_wait"):
        return realized < 0
    return abs(realized) < t["hold_band_pct"]


def signal_stats(levels, predicted, realized, t):
    result = {}
    for level in LEVELS:
        index = [i for i, value in enumerate(levels) if value == level]
        result[level] = dict(days=len(index), share=len(index)/len(levels)*100 if levels else 0,
                             avg_predicted=float(np.mean([predicted[i] for i in index])) if index else None,
                             avg_realized=float(np.mean([realized[i] for i in index])) if index else None,
                             hit=float(np.mean([signal_hit(level, realized[i], t) for i in index])*100) if index else None)
    called = [i for i, value in enumerate(levels) if value != "hold"]
    result["direction_hit"] = float(np.mean([signal_hit(levels[i], realized[i], t) for i in called])*100) if called else None
    return result


def signal_windows(dates, levels, predicted, realized, reliable, t, wanted=("must_buy", "strong_wait"), min_days=3):
    """Runs of the same urgent signal, so the screen can say 'from this day to that day: buy now'."""
    windows, i = [], 0
    while i < len(levels):
        j = i
        while j+1 < len(levels) and levels[j+1] == levels[i]:
            j += 1
        if levels[i] in wanted and j-i+1 >= min_days:
            windows.append(dict(level=levels[i], start=dates[i], end=dates[j], days=j-i+1,
                                avg_predicted=float(np.mean(predicted[i:j+1])), avg_realized=float(np.mean(realized[i:j+1])),
                                hit=float(np.mean([signal_hit(levels[i], r, t) for r in realized[i:j+1]])*100),
                                reliable_share=float(np.mean(reliable[i:j+1])*100)))
        i = j+1
    return windows


class Lab:
    def __init__(self, ops):
        self.ops, self.store = ops, ops.store
        self.root = self.store.root/"service"
        self.bundles, self.cache, self.cfg_cache = {}, None, None

    @property
    def rules(self):
        """The few knobs (quantiles, safety cap) merged with every number derived from the data and the model."""
        return {**RULES["service_lab"], **self.config()}

    def config(self):
        """Everything numeric is computed: observation step from the data, windows from the model's horizon and the
        existing fine-tune rule, the baseline cutoff from the history length. Nothing here is a typed-in date or day count."""
        rows = self.rows()
        key = (len(rows), rows[-1]["date"])
        if self.cfg_cache and self.cfg_cache[0] == key:
            return self.cfg_cache[1]
        gate = RULES["gate"]["finetune"]
        horizon = HORIZON_DAYS
        window = performance_window(DAILY)
        official = [date.fromisoformat(r["date"]) for r in rows if not r.get("derived")]
        step = int(np.median([(b-a).days for a, b in zip(official, official[1:])])) if len(official) > 2 else 1
        reference, current = gate["window_weeks"]*7, 2*horizon
        cutoff = rows[int(len(rows)*RULES["service_lab"]["baseline_share"])]["date"]
        self.cfg_cache = (key, dict(
            baseline_cutoff=cutoff, ks_lag_days=step, ks_reference_days=reference, ks_current_days=current,
            min_gap_days=window+current, min_eval_days=horizon+window//2, episode_merge_days=window, episode_follow_days=horizon+window,
            default_cooldown_days=window+horizon, cooldown_options=[window, window+horizon, 2*(window+horizon)],
            # A lab fine-tune learns from as many weeks as the check that judges it (the holdout), so it follows the new regime
            # instead of averaging it with a year of the old one; longer windows stay selectable.
            default_window_weeks=gate["holdout_weeks"], window_weeks_options=[gate["holdout_weeks"]*m for m in (1, 2, 4, 8)],
            # The newest labelled forecast is already one horizon old, so the check that judges a candidate is one horizon long:
            # anything longer pushes the end of its training data further from the regime it is meant to learn.
            lab_holdout_weeks=horizon//7,
            tune_epochs=gate["epochs"]*RULES["service_lab"]["tune_epoch_multiplier"], tune_lr=gate["learning_rate"]*RULES["service_lab"]["tune_lr_multiplier"],
            tune_patience=RULES["service_lab"]["tune_patience"],
            default_eval_weeks=gate["holdout_weeks"], eval_weeks_options=[max(2, round(gate["holdout_weeks"]/2)), gate["holdout_weeks"], gate["holdout_weeks"]*2],
            confirm_days=RULES["monitoring"]["warn_consecutive"], horizon_days=horizon, window_days=window, holdout_days=horizon, holdout_weeks=horizon//7,
            observation_step_days=step))
        return self.cfg_cache[1]

    def rows(self):
        rows = self.ops.dataset()["rows"]
        if rows[0]["interval_days"] != DAILY or any(row["synthetic"] is not False for row in rows):
            raise ValueError("서비스 랩은 실제 일일 가격 데이터에서만 동작합니다")
        return rows

    def baseline(self):
        record = self.store.latest("service_baselines")
        if record is None:
            raise FileNotFoundError("기준 모델이 없습니다: 먼저 기준 모델을 학습하세요")
        return record

    def bundle(self, name):
        if name not in self.bundles:
            self.bundles[name] = models.Bundle(self.root/"models"/name)
        return self.bundles[name]

    def limits(self, rows):
        cutoff = date.fromisoformat((self.store.latest("service_baselines") or {}).get("cutoff") or self.rules["baseline_cutoff"])
        return ((cutoff+timedelta(days=self.rules["min_gap_days"])).isoformat(),
                (date.fromisoformat(rows[-1]["date"])-timedelta(days=self.rules["min_eval_days"])).isoformat())

    def status(self):
        try:
            rows = self.rows()
        except ValueError as error:
            return dict(ready=False, unsupported=str(error), rules=RULES["service_lab"])
        first, last = self.limits(rows)
        record = self.store.latest("service_baselines")
        return dict(ready=record is not None, baseline=record, rules=self.rules, config=dict(self.config(), shock_defaults=self.shock_defaults()), unit=rows[0]["unit"],
                    data_start=rows[0]["date"], data_end=rows[-1]["date"], min_date=first, max_date=last)

    def register(self, folder, name, role, job_id, parent=None, reference=None, synthetic=False, trained_on=None, decision=None):
        """Put a lab model into the Models section (the same registry production uses): a numbered version with its files,
        an MLflow run and checks, so it can be inspected, selected or rolled back from there. Models learned from made-up
        prices are stored too, flagged, and production refuses them."""
        rows = self.rows()
        metadata = json.loads((folder/"bundle.json").read_text())
        with self.store.lock:
            pipeline = Pipeline(self.ops)
            registry = pipeline.next_version()
            target = self.store.root/"models"/registry
            shutil.copytree(folder, target)
        metadata.update(from_lab=job_id, lab_name=name, lab_role=role, lab_parent=parent, lab_reference=reference, lab_decision=decision, synthetic=bool(synthetic))
        (target/"bundle.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2))
        run_id = models.track(target, metadata)               # also rewrites bundle.json with the run id
        health = pipeline.check_artifacts(registry)           # hashes + reload + same answer as before saving
        calibration = calibrate(rows, metadata["test_start"])
        self.store.append("bundle_calibrations", dict(calibration, version=registry, rmse=[], wape=[]))
        self.store.append("models", dict(json.loads((target/"bundle.json").read_text()), version=registry, data_version=trained_on or version(rows),
                                         trigger_id=job_id, source=rows[0]["source"], at=stamp(), mlflow_run_id=run_id,
                                         artifact_health=health, operational_validation_passed=True, experiment_id=None))
        self.ops.log("INFO", f"service lab model {name} registered as {registry} ({role}{', 가상 데이터' if synthetic else ''})")
        return registry

    def train_baseline(self, job_id, rows, epochs=40):
        """The model that is 'already in service' in the replay: trained only on rows up to the cutoff."""
        cutoff = self.rules["baseline_cutoff"]
        train = [dict(row) for row in rows if row["date"] <= cutoff]
        name = f"baseline_{job_id}"
        self.ops.log("INFO", f"service baseline {name} training rows={len(train)} until={cutoff}")
        metadata = models.train_bundle(train, self.root/"models"/name, epochs=epochs, interval_days=DAILY,
                                       synthetic=False, force_refit=True, on_epoch=lambda record: self.ops.check_cancel(job_id))
        record = dict(name=name, job_id=job_id, cutoff=cutoff, trained_through=metadata["trained_through"],
                      gate=metadata["gate"], epochs_run=metadata["epochs_run"], refit=metadata["refit"], data_version=version(train), at=stamp())
        record["registry"] = self.register(self.root/"models"/name, name, "baseline", job_id, reference=dict(
            start=train[-self.rules["ks_reference_days"]]["date"], end=train[-1]["date"]), trained_on=version(train))
        self.store.append("service_baselines", record)
        self.cache = None
        self.ops.log("OK" if metadata["gate"]["passed"] else "WARN",
                     f"service baseline {name} ready: {models.gate_summary(metadata['gate'])}")
        return dict(name=name, gate_passed=metadata["gate"]["passed"], cutoff=cutoff)

    def timeline(self, rows=None):
        """Per-day baseline error and input drift over the whole history, plus the detected drift episodes.
        `rows` is given only for a simulation with made-up prices; that timeline is computed fresh and never cached."""
        real = rows is None
        rows, record = (self.rows() if real else rows), self.baseline()
        key = (self.ops.dataset()["version"], record["name"])
        if real and self.cache and self.cache[0] == key:
            return self.cache[1]
        bundle, cutoff = self.bundle(record["name"]), record["cutoff"]
        dates, prices = [r["date"] for r in rows], np.asarray([r["midpoint"] for r in rows])
        samples = models.build_samples(rows, interval_days=DAILY)
        predicted = bundle.predict_many([[v[0] for v in s["x"]] for s in samples])
        actual = np.asarray([s["actual"] for s in samples])
        error_sum = np.concatenate([[0], np.cumsum(np.abs(actual-predicted))])
        actual_sum = np.concatenate([[0], np.cumsum(actual)])
        known = [s["actual_known_at"] for s in samples]
        window, first_clean = performance_window(DAILY), (date.fromisoformat(cutoff)+timedelta(days=performance_window(DAILY))).isoformat()
        wape = []
        for day in dates:
            end = bisect.bisect_right(known, day)
            wape.append(None if day < first_clean or end < window else
                        round(float((error_sum[end]-error_sum[end-window])/(actual_sum[end]-actual_sum[end-window])*100), 3))
        # The daily series is interpolated between weekly observations, so one-day returns are step-like and the KS
        # test saturates. Input drift is therefore measured on `lag`-day log returns over long windows.
        lag, reference_n, current_n = (self.rules[k] for k in ("ks_lag_days", "ks_reference_days", "ks_current_days"))
        returns, cut = lagged_returns(prices, lag), dates.index(cutoff)
        # Bound: on the baseline's own history, how far does a 60-day window drift from the 365 days before it?
        calm_stats = [window_stats(returns, (end-current_n-reference_n+1, end-current_n), end, current_n) for end in range(lag+reference_n+current_n, cut+1)]
        calm_stats = [v for v in calm_stats if v is not None]
        calm = [v["ks"] for v in calm_stats]
        ks_limit = float(np.quantile(calm, self.rules["ks_quantile"])) if len(calm) >= 20 else None
        cause_limits = dict(mean_shift=float(np.quantile([abs(v["mean_shift"]) for v in calm_stats], self.rules["ks_quantile"])),
                            log_vol=float(np.quantile([abs(math.log(v["vol_ratio"])) for v in calm_stats if v["vol_ratio"] > 0], self.rules["ks_quantile"]))) if len(calm_stats) >= 20 else None
        # Drift after the cutoff: the latest 60 days against the window the baseline was fitted on (fixed, not rolling).
        reference = (cut-reference_n+1, cut)
        ks = [None]*len(dates)
        for i in range(cut+1, len(dates)):
            ks[i] = window_ks(returns, reference, i, current_n)
        out_of_sample = json.loads((self.root/"models"/record["name"]/"evaluation.json").read_text())
        windows, changes, moves = [], [], []
        for part in ("validation", "test"):     # everything the baseline was scored on without having trained on it
            held = out_of_sample[part]
            windows += [accuracy([r["actual"] for r in held[end-window:end]], [r["prediction"] for r in held[end-window:end]])["wape"]["value"]
                        for end in range(window, len(held)+1)]
            changes += [(r["prediction"]/r["x"][-1][0]-1)*100 for r in held]
            moves += [abs(r["actual"]/r["x"][-1][0]-1)*100 for r in held]
        if len(windows) < 20:
            raise ValueError("기준 모델의 표본 외 구간이 짧아 경계를 계산할 수 없습니다")
        wape_limit = float(np.quantile(windows, self.rules["warn_quantile"]))
        tune_limit = max(float(np.quantile(windows, self.rules["tune_quantile"])), wape_limit)
        q = self.rules["signal_quantiles"]
        signals = dict(must_buy_pct=float(np.quantile(changes, q["must_buy"])), buy_pct=float(np.quantile(changes, q["buy"])),
                       wait_pct=float(np.quantile(changes, q["wait"])), strong_wait_pct=float(np.quantile(changes, q["strong_wait"])),
                       hold_band_pct=float(np.median(moves)), samples=len(changes), quantiles=q)
        first, last = self.limits(rows)
        episodes = self.episodes(dates, prices, ks, wape, ks_limit, wape_limit, tune_limit, cutoff, first, last)
        payload = dict(dates=dates, price=[round(float(p), 2) for p in prices], wape=wape,
                       ks=[None if v is None else round(v, 4) for v in ks], ks_limit=ks_limit, wape_limit=wape_limit, wape_tune_limit=tune_limit, signals=signals, cause_limits=cause_limits, windows_scored=len(windows), config=self.config(),
                       cutoff=cutoff, min_date=first, max_date=last, unit=rows[0]["unit"], episodes=episodes,
                       reference_window=dict(start=dates[reference[0]], end=dates[reference[1]], days=reference[1]-reference[0]+1),
                       max_period_end=(date.fromisoformat(dates[-1])-timedelta(days=28)).isoformat(),
                       baseline=record)
        if cause_limits:
            for episode in episodes:
                episode["cause"] = drift_cause(window_stats(returns, reference, dates.index(episode["t"]), current_n), cause_limits)
        if real:
            self.cache = (key, payload)
        return payload

    def episodes(self, dates, prices, ks, wape, ks_limit, wape_limit, tune_limit, cutoff, first, last):
        """Runs of confirmed input drift (KS above its calibrated bound on two consecutive days, the production rule)."""
        if ks_limit is None:
            return []
        exceed = [value is not None and value > ks_limit for value in ks]
        need = self.rules["confirm_days"]
        confirmed = [i for i in range(need-1, len(dates)) if all(exceed[i-d] for d in range(need)) and dates[i] > cutoff]
        groups = []
        for i in confirmed:
            gap = (date.fromisoformat(dates[i])-date.fromisoformat(dates[groups[-1][-1]])).days if groups else None
            if groups and gap <= self.rules["episode_merge_days"]:
                groups[-1].append(i)
            else:
                groups.append([i])
        result = []
        for group in groups:
            selectable = [i for i in range(group[0], group[-1]+1) if first <= dates[i] <= last]
            if not selectable:
                continue
            peak = max(selectable, key=lambda i: ks[i])
            # The model's labels arrive 28 days late, so its error shows up after the drift does: the representative
            # day is where the baseline is worst within the episode and the weeks right after it.
            after = [i for i in range(group[0], min(group[-1]+self.rules["episode_follow_days"], len(dates)-1)+1)
                     if first <= dates[i] <= last and wape[i] is not None]
            at = max(after, key=lambda i: wape[i]) if after else peak
            confirmed_at = at >= need-1 and all(ks[at-d] is not None and ks[at-d] > ks_limit for d in range(need))
            before = max(0, at-30)
            result.append(dict(start=dates[group[0]], end=dates[group[-1]], days=len(range(group[0], group[-1]+1)),
                               peak_date=dates[peak], peak_ks=round(ks[peak], 4), strength=round(ks[peak]/ks_limit, 2),
                               t=dates[at], wape_at_t=wape[at], base_stage=2 if confirmed_at or stage(wape[at], wape_limit, tune_limit) == 2 else max(stage(wape[at], wape_limit, tune_limit), 1),
                               base_trigger=("both" if confirmed_at and stage(wape[at], wape_limit, tune_limit) == 2 else "drift" if confirmed_at else
                                             "wape" if stage(wape[at], wape_limit, tune_limit) == 2 else None),
                               base_failing=confirmed_at or stage(wape[at], wape_limit, tune_limit) == 2,
                               price_change_pct=round(float((prices[at]/prices[before]-1)*100), 1)))
        return result

    def validate(self, day, eval_weeks):
        rows = self.rows()
        self.baseline()
        first, last = self.limits(rows)
        if day not in {row["date"] for row in rows}:
            raise ValueError(f"{day}: 데이터에 없는 날짜입니다")
        if not first <= day <= last:
            raise ValueError(f"선택 가능한 시점은 {first} ~ {last} 입니다 (기준 모델 학습 구간·비교 구간 확보)")

    def replay(self, job_id, day, window_weeks=52, eval_weeks=13, force=False):
        rows, record = self.rows(), self.baseline()
        self.validate(day, eval_weeks)
        timeline = self.timeline()
        at = timeline["dates"].index(day)
        base = self.bundle(record["name"])
        wape_now, ks_now = timeline["wape"][at], timeline["ks"][at]
        wape_level = stage(wape_now, timeline["wape_limit"], timeline["wape_tune_limit"])
        failing = wape_level == 2
        limit_ks = timeline["ks_limit"]
        prices_arr = np.asarray([r["midpoint"] for r in rows])
        row_pos = {r["date"]: i for i, r in enumerate(rows)}
        cut_i = row_pos[record["cutoff"]]
        cause = drift_cause(window_stats(lagged_returns(prices_arr, self.rules["ks_lag_days"]), (cut_i-self.rules["ks_reference_days"]+1, cut_i),
                                         row_pos[day], self.rules["ks_current_days"]), timeline["cause_limits"]) if timeline["cause_limits"] else None
        need = self.rules["confirm_days"]
        recent = [timeline["ks"][at-d] for d in range(1, need)]
        drifting = ks_now is not None and limit_ks is not None and ks_now > limit_ks
        confirmed = drifting and all(v is not None and v > limit_ks for v in recent)     # `confirm_days` in a row, as in production
        level = 2 if confirmed else max(wape_level, 1 if drifting else 0)
        decision = dict(day=day, wape=wape_now, wape_limit=timeline["wape_limit"], wape_tune_limit=timeline["wape_tune_limit"],
                        stage=level, wape_stage=wape_level, trigger=("both" if confirmed and failing else "drift" if confirmed else "wape" if failing else None), ks=ks_now, ks_limit=timeline["ks_limit"], failing=failing, input_drift=drifting, drift_confirmed=confirmed,
                        forced=bool(force and not (failing or confirmed)), tune=failing or confirmed or force,
                        reference_window=timeline["reference_window"], cause=cause,
                        reason=(f"2단계: 최근 {performance_window(DAILY)}일 WAPE {wape_now:.2f}% > {timeline['wape_tune_limit']:.2f}% → 파인튜닝"
                                if failing else
                                f"2단계: 최근 60일이 기준 모델 학습 윈도우({timeline['reference_window']['start']}~{timeline['reference_window']['end']})와 달라짐 "
                                f"(KS {ks_now:.2f} > {limit_ks:.2f}, {need}일 연속) → 파인튜닝" if confirmed else "사용자가 파인튜닝을 강제" if force else
                                f"1단계 경고: WAPE {wape_now:.2f}% > {timeline['wape_limit']:.2f}% (파인튜닝 기준 {timeline['wape_tune_limit']:.2f}% 미만) → 경고만"
                                if level == 1 and wape_level == 1 else
                                f"1단계 경고: 최근 60일이 학습 윈도우와 달라지는 중 (KS {ks_now:.2f} > {limit_ks:.2f}, 아직 {len([v for v in recent if v is not None and v > limit_ks])+1}일째) → 경고만"
                                if level == 1 else
                                f"정상: WAPE {wape_now:.2f}% ≤ {timeline['wape_limit']:.2f}% → 파인튜닝 안 함"))
        self.ops.log("WARN" if failing or confirmed else "INFO", f"service replay {job_id} T={day} {decision['reason']}")
        visible = [dict(row) for row in rows if row["date"] <= day]
        last_issue = (date.fromisoformat(day)+timedelta(days=eval_weeks*7)).isoformat()
        evaluation = [s for s in models.build_samples(rows, interval_days=DAILY) if day < s["issued_at"] <= last_issue]
        inputs = [[v[0] for v in s["x"]] for s in evaluation]
        base_predicted = base.predict_many(inputs)
        result = dict(id=job_id, at=stamp(), day=day, window_weeks=window_weeks, eval_weeks=eval_weeks, unit=rows[0]["unit"],
                      baseline=record["name"], decision=decision, tuned=None, metrics=dict(after=dict(base=scores(evaluation, base_predicted))))
        tuned_predicted = None
        if decision["tune"]:
            folder = self.root/"models"/f"tuned_{job_id}"
            started = time.perf_counter()
            metadata = models.train_bundle(visible, folder, interval_days=DAILY, base=self.root/"models"/record["name"],
                                           finetune=True, window_weeks=window_weeks, holdout_weeks=rules["lab_holdout_weeks"], synthetic=False,
                                           tune_epochs=rules["tune_epochs"], tune_lr=rules["tune_lr"], tune_patience=rules["tune_patience"],
                                           on_epoch=lambda r: self.ops.check_cancel(job_id))
            tuned = models.Bundle(folder)
            tuned_predicted = tuned.predict_many(inputs)
            holdout = json.loads((folder/"evaluation.json").read_text())["validation"]
            hold_base = scores(holdout, base.predict_many([[v[0] for v in r["x"]] for r in holdout]))
            hold_tuned = scores(holdout, [r["prediction"] for r in holdout])
            beats = hold_tuned["wape"] < hold_base["wape"]
            gate_ok = metadata["gate"]["passed"] and beats
            result["metrics"]["holdout"] = dict(base=hold_base, tuned=hold_tuned)
            result["metrics"]["after"]["tuned"] = scores(evaluation, tuned_predicted)
            result["tuned"] = dict(name=f"tuned_{job_id}", epochs=metadata["epochs_run"], seconds=time.perf_counter()-started,
                                   train_samples=metadata["partition_counts"]["train"], holdout_samples=len(holdout),
                                   train_end=metadata["train_end"], gate=metadata["gate"], beats_baseline_on_holdout=beats,
                                   gate_passed=gate_ok, learning_history=metadata["learning_history"],
                                   window_start=visible[-(window_weeks*7+91):][0]["date"], window_end=day)
            self.ops.log("GATE PASSED" if gate_ok else "GATE FAILED",
                         f"service replay {job_id} tuned_{job_id}: 직전 {len(holdout)}일 WAPE {hold_base['wape']:.2f}% → {hold_tuned['wape']:.2f}%")
        result.update(self.comparison(evaluation, base_predicted, tuned_predicted, rows, day))
        result["verdict"] = self.verdict(result)
        self.store.append("service_replays", result)
        self.ops.log("INFO", f"service replay {job_id} done: {result['verdict']['code']}")
        return dict(id=job_id, tuned=bool(result["tuned"]), verdict=result["verdict"]["code"])

    def shock_defaults(self):
        """What a 'big' shock means on THIS price history: the largest one-year rise it ever had, and the size of its
        usual month-to-month swing - so the made-up regime is as violent as the real market has been, not an arbitrary number."""
        rows = self.rows()
        prices = np.asarray([r["midpoint"] for r in rows])
        year, horizon = self.rules["ks_reference_days"], self.rules["horizon_days"]
        rise = float((prices[year:]/prices[:-year]).max()-1)*100
        swing = float(np.quantile(np.abs(prices[horizon:]/prices[:-horizon]-1), .95))*100
        return dict(days=year, pct=round(rise, 0), wave_pct=round(swing, 0), wave_days=2*horizon)

    def inject(self, rows, shock):
        """A made-up regime for the simulation: from `start` the price climbs by `pct`% over `days` days at a steady daily
        drift while it swings up and down by `wave_pct`% every `wave_days` days (the 'recent trend continues' rule stops
        working), then stays at the new level. Every changed row is marked synthetic; the real dataset is never touched."""
        first = next(i for i, row in enumerate(rows) if row["date"] >= shock["start"])
        drift = math.log(1+shock["pct"]/100)/shock["days"]
        amplitude, period = math.log(1+(shock.get("wave_pct") or 0)/100), shock.get("wave_days") or 56
        whole = shock["days"]//period*period      # stop the swing on a full cycle so it leaves no step behind
        def factor(k):
            return math.exp(drift*min(k, shock["days"]) + amplitude*math.sin(2*math.pi*min(k, whole)/period))
        return [row if i < first else dict(row, midpoint=row["midpoint"]*factor(i-first+1), synthetic=True, injected=i-first < shock["days"])
                for i, row in enumerate(rows)]

    def validate_shock(self, shock, start, end):
        if not start <= shock["start"] <= end:
            raise ValueError("가상 충격 시작일은 운영 구간 안이어야 합니다")
        if shock["days"] < 7 or not -90 < shock["pct"] < 1000 or shock["pct"] == 0:
            raise ValueError("가상 충격은 7일 이상, 변화율은 0이 아닌 −90% ~ +1000% 사이여야 합니다")

    def validate_period(self, start, end):
        rows = self.rows()
        self.baseline()
        first, last = self.limits(rows)
        last_issue = (date.fromisoformat(rows[-1]["date"])-timedelta(days=28)).isoformat()
        dates = {row["date"] for row in rows}
        if start not in dates or end not in dates:
            raise ValueError("데이터에 없는 날짜입니다")
        if start < first or end > last_issue:
            raise ValueError(f"선택 가능한 구간은 {first} ~ {last_issue} 입니다 (기준 모델 학습 구간·정답 확정 구간 확보)")
        if (date.fromisoformat(end)-date.fromisoformat(start)).days < 28:
            raise ValueError("구간은 최소 28일이어야 합니다")

    # ------------------------------------------------------------------ ops helpers
    def quality_issues(self, rows, i, official, step):
        """Data-quality faults of the newest observation. They are not market drift: retraining on them would be wrong."""
        row, issues = rows[i], []
        limits = RULES["data_quality"]
        if not math.isfinite(row["midpoint"]) or row["midpoint"] <= 0:
            issues.append(dict(kind="invalid", message="가격이 유한 양수가 아닙니다"))
        if i > 0 and (date.fromisoformat(row["date"])-date.fromisoformat(rows[i-1]["date"])).days != rows[0]["interval_days"]:
            issues.append(dict(kind="gap", message="관측 누락 구간이 있습니다"))
        if i >= step and rows[i-step]["midpoint"] > 0:
            ratio = row["midpoint"]/rows[i-step]["midpoint"]
            if not limits["min_weekly_ratio"] <= ratio <= limits["max_weekly_ratio"]:
                issues.append(dict(kind="unit", message=f"{step}일 변화가 {ratio:.2f}배: 단위 혼입 의심"))
        at = bisect.bisect_right(official, i)-1
        if at < 0 or i-official[at] > 2*step:
            issues.append(dict(kind="stale", message=f"공식 관측이 {i-official[at] if at >= 0 else '?'}일째 갱신되지 않았습니다"))
        return issues

    def notify(self, level, title, body, job_id=None, day=None):
        """Route an event: level info/warn/page → channel. Always kept in the outbox table; it leaves this
        machine only when BUTTERCAST_WEBHOOK_URL is set by whoever runs the server."""
        record = dict(at=stamp(), level=level, title=title, body=body, job_id=job_id, day=day, delivery="outbox",
                      detail="웹훅 미설정 — 알림함에만 기록")
        url = os.environ.get("BUTTERCAST_WEBHOOK_URL")
        if url:
            try:
                request = urllib.request.Request(url, data=json.dumps(record, ensure_ascii=False).encode(), headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(request, timeout=3):
                    record.update(delivery="sent", detail="웹훅 전송 완료")
            except Exception as error:     # a broken webhook must never stop the run
                record.update(delivery="failed", detail=f"웹훅 실패: {error}")
        self.store.append("service_notifications", record)
        return record

    def run_period(self, job_id, start, end, window_weeks=None, cooldown_days=None, pace=0.0, promotion="shadow", shock=None, start_model=None):
        """Walk the period day by day like a live service.

        Monitoring: the serving model's trailing WAPE (step 1 warns, step 2 fine-tunes) and the latest window against the
        window it learned from (drift). Data-quality faults hold retraining back. A fine-tuned candidate is first screened
        on the weeks before the trigger, then (promotion="shadow") runs beside the champion without serving until enough
        real answers matured, and replaces it automatically as soon as it is better - no human in the loop.
        promotion: "gate" screen only · "shadow" screen + live shadow · "always" comparison mode, no screening.
        Every simulated day is appended to the `live_<job>` table so the screen can follow; `pace` is the pause per day."""
        rows, record = self.rows(), self.baseline()
        self.validate_period(start, end)
        if not record.get("registry"):     # a baseline trained before models were saved: save it now, once
            real = self.rows()
            cut = next(i for i, r in enumerate(real) if r["date"] == record["cutoff"])
            record = dict(record, registry=self.register(self.root/"models"/record["name"], record["name"], "baseline", record["job_id"],
                                                         reference=dict(start=real[cut-self.rules["ks_reference_days"]+1]["date"], end=record["cutoff"])))
            self.store.append("service_baselines", record)
        if shock:
            self.validate_shock(shock, start, end)
            rows = self.inject(rows, shock)
        timeline, rules = (self.timeline(rows=rows) if shock else self.timeline()), self.rules
        window_weeks = window_weeks or rules["default_window_weeks"]
        cooldown_days = cooldown_days or rules["default_cooldown_days"]
        window = performance_window(DAILY)
        shadow_n = rules["window_days"]       # a challenger must be judged on as many real answers as the monitor window holds
        samples = models.build_samples(rows, interval_days=DAILY)
        inputs = [[v[0] for v in s["x"]] for s in samples]
        actual = np.asarray([s["actual"] for s in samples])
        issued, known = [s["issued_at"] for s in samples], [s["actual_known_at"] for s in samples]
        row_index = {row["date"]: i for i, row in enumerate(rows)}
        official = [i for i, row in enumerate(rows) if not row.get("derived")]
        step = rules["observation_step_days"]
        first, last = issued.index(start), issued.index(end)
        base = self.bundle(record["name"])
        fixed = base.predict_many(inputs)
        served, serving, serving_name = fixed.copy(), base, record["name"]
        old_preds = {}
        folders = {record["name"]: self.root/"models"/record["name"]}
        registry_of = {record["name"]: record.get("registry")}
        start_reference = None
        if start_model:      # begin from a model saved in the Models section instead of the baseline
            saved = next((m for m in self.store.read("models") if m["version"] == start_model and m.get("from_lab")), None)
            if saved is None:
                raise ValueError(f"{start_model}: 서비스 랩에서 저장한 모델이 아닙니다")
            serving, serving_name = models.Bundle(self.store.root/"models"/start_model), start_model
            served = serving.predict_many(inputs)
            folders[start_model] = self.store.root/"models"/start_model
            start_reference = saved.get("lab_reference")
        candidate = np.full(len(samples), np.nan)    # what the latest fine-tune would say, promoted or not
        events, tunes, last_tune, owner = [], 0, None, [serving_name]*len(samples)
        challenger, holds, quality_log, lineage, notes = None, [], [], [], 0
        live, drifting_days, drift_open, warn_open, quality_open, warnings = f"live_{job_id}", 0, False, False, False, []
        lag, current_n = rules["ks_lag_days"], rules["ks_current_days"]
        prices = np.asarray([row["midpoint"] for row in rows])
        returns = lagged_returns(prices, lag)
        reference = (row_index[start_reference["start"]], row_index[start_reference["end"]]) if start_reference else (
            row_index[record["cutoff"]]-rules["ks_reference_days"]+1, row_index[record["cutoff"]])   # window the serving model learned from
        warn_limit, tune_limit = timeline["wape_limit"], timeline["wape_tune_limit"]
        slo_target = rules["warn_quantile"]
        allowed_bad = (1-slo_target)*(last-first+1)
        bad_days, budget_alerted = 0, False
        self.ops.log("INFO", f"service period {job_id} {start}~{end} promotion={promotion} window={window_weeks}w cooldown={cooldown_days}d")

        def notify(level, title, body, day):
            self.notify(level, title, body, job_id, day)

        def conclude(event, tuned, k_now, accepted, why, basis):
            """Final decision on a candidate: swap or keep, automatically; writes the lineage record."""
            nonlocal served, serving, serving_name, reference
            event.update(promoted=bool(accepted), decided_on=issued[k_now], decision=why, decision_metrics=basis)
            if accepted:
                if k_now+1 < len(inputs):
                    old_preds[event["candidate"]] = (k_now, serving.predict_many(inputs[k_now+1:]))    # what the old model would have said from here on
                    served[k_now+1:] = candidate[k_now+1:]
                    owner[k_now+1:] = [event["candidate"]]*(len(samples)-k_now-1)
                parent_registry = serving_name if serving_name.startswith("v") and serving_name[1:].isdigit() else registry_of.get(serving_name)
                serving, serving_name = tuned, event["candidate"]
                folders[serving_name] = self.root/"models"/serving_name
                reference = (row_index[event["window_start"]], row_index[event["day"]])    # "normal" now means the new model's window
                # every replacement is saved in the Models section so it can be inspected, selected or rolled back there
                event["registry_version"] = registry_of[serving_name] = self.register(
                    folders[serving_name], serving_name, "tuned", job_id, parent=parent_registry,
                    reference=dict(start=event["window_start"], end=event["day"]), synthetic=bool(shock), trained_on=event.get("data_version"), decision=basis)
            self.store.append(live, dict(type="decision", day=issued[k_now], candidate=event["candidate"], promoted=bool(accepted), why=why,
                                         trigger=event["trigger"], metrics=basis))
            self.ops.log("OK" if accepted else "FAIL", f"service period {job_id} {issued[k_now]}: {event['candidate']} {'교체' if accepted else '유지'} — {why}")
            notify("page" if accepted else "warn", f"{'모델 교체' if accepted else '후보 탈락'} · {event['candidate']}", why, issued[k_now])

        for k in range(first, last+1):
            day = issued[k]
            known_count = bisect.bisect_right(known, day)
            window_part = slice(known_count-window, known_count)
            current = None if known_count < window else float(np.abs(actual[window_part]-served[window_part]).sum()/actual[window_part].sum()*100)
            ridx = row_index[day]
            stats = window_stats(returns, reference, ridx, current_n)   # latest window vs the one the serving model learned from
            ks_now = stats["ks"] if stats else None
            over = ks_now is not None and timeline["ks_limit"] is not None and ks_now > timeline["ks_limit"]
            drifting_days = drifting_days+1 if over else 0
            confirmed = drifting_days >= rules["confirm_days"]          # consecutive days, as in production (monitoring.warn_consecutive)
            wape_stage = stage(current, warn_limit, tune_limit)
            level = 2 if confirmed else max(wape_stage, 1 if over else 0)
            issues = self.quality_issues(rows, ridx, official, step)
            if issues and not quality_open:
                quality_open = True
                quality_log.append(dict(start=day, end=day, issues=issues))
                self.ops.log("ERROR", f"service period {job_id} {day}: 데이터 품질 문제 {'; '.join(i['message'] for i in issues)} → 재학습 보류")
                self.store.append(live, dict(type="quality", day=day, issues=issues))
                notify("page", "데이터 품질 문제", "; ".join(i["message"] for i in issues)+" — 이 데이터로 재학습하지 않습니다", day)
            elif quality_open and not issues:
                quality_open = False
                self.ops.log("INFO", f"service period {job_id} {day}: 데이터 품질 정상 복귀")
                self.store.append(live, dict(type="quality_end", day=day))
            if quality_open:
                quality_log[-1]["end"] = day
            what = f"WAPE {current:.2f}%" if wape_stage else f"입력 분포 KS {ks_now:.2f} (학습 윈도우 {rows[reference[0]]['date']}~{rows[reference[1]]['date']} 대비)" if over else ""
            if level and not warn_open:     # step 1: tell, do not touch the model
                warn_open = True
                warnings.append(dict(start=day, end=day, peak=current or 0.0, by="오차" if wape_stage else "드리프트"))
                self.ops.log("WARN", f"service period {job_id} {day}: 1단계 경고 {what}")
                self.store.append(live, dict(type="warn", day=day, wape=current, wape_limit=warn_limit, wape_tune_limit=tune_limit, what=what))
                notify("warn", "1단계 경고", what, day)
            elif warn_open and not level:
                warn_open = False
                self.ops.log("INFO", f"service period {job_id} {day}: 경고 해제")
                self.store.append(live, dict(type="warn_end", day=day, wape=current))
            if warn_open and level:
                warnings[-1].update(end=day, peak=max(warnings[-1]["peak"], current or 0.0))
            if current is not None and current > warn_limit:
                bad_days += 1
                if bad_days > allowed_bad and not budget_alerted:
                    budget_alerted = True
                    self.ops.log("ERROR", f"service period {job_id} {day}: 오차 SLO 에러 버짓 소진 ({bad_days}일 > 허용 {allowed_bad:.1f}일)")
                    self.store.append(live, dict(type="slo_breach", day=day, bad_days=bad_days, allowed=allowed_bad))
                    notify("page", "오차 SLO 에러 버짓 소진", f"경고 경계 초과 {bad_days}일 > 허용 {allowed_bad:.1f}일 (목표 {slo_target*100:.0f}%)", day)
            last_price = samples[k]["x"][-1][0]
            if drifting_days == rules["confirm_days"] and not drift_open:
                drift_open = True
                cause = drift_cause(stats, timeline["cause_limits"]) if timeline["cause_limits"] else None
                self.ops.log("WARN", f"service period {job_id} {day}: input drift detected KS {ks_now:.3f} > {timeline['ks_limit']:.3f} {rules['confirm_days']}일 연속"
                                     + (f" · 원인 {cause['kind']}" if cause else ""))
                self.store.append(live, dict(type="drift_alert", day=day, ks=ks_now, ks_limit=timeline["ks_limit"], cause=cause))
                notify("warn", "입력 드리프트 감지", f"KS {ks_now:.2f} > {timeline['ks_limit']:.2f}" + (f" · {cause['kind']}" if cause else ""), day)
            elif drift_open and not over:
                drift_open = False
                self.ops.log("INFO", f"service period {job_id} {day}: input drift resolved")
                self.store.append(live, dict(type="drift_resolved", day=day))
            matured = None
            if known_count:
                j = known_count-1
                matured = dict(actual=float(actual[j]), last=float(samples[j]["x"][-1][0]), fixed=float(fixed[j]), adaptive=float(served[j]),
                               candidate=None if not np.isfinite(candidate[j]) else float(candidate[j]))
            shadow_done = 0 if challenger is None else max(0, known_count-1-challenger["k0"])
            self.store.append(live, dict(
                type="day", candidate=None if not np.isfinite(candidate[k]) else float(candidate[k]), matured=matured, k=k-first, n=last-first+1, day=day, price=float(last_price), target_date=samples[k]["target_date"],
                fixed=float(fixed[k]), adaptive=float(served[k]), level=signal_level((served[k]/last_price-1)*100, timeline["signals"]),
                level_fixed=signal_level((fixed[k]/last_price-1)*100, timeline["signals"]), wape=current, wape_limit=warn_limit, wape_tune_limit=tune_limit, stage=level,
                ks=ks_now, ks_limit=timeline["ks_limit"], drift=over, confirmed=confirmed, serving=serving_name, tunes=tunes,
                quality=[i["kind"] for i in issues], synthetic=bool(rows[ridx].get("injected")), bad_days=bad_days, allowed_bad=allowed_bad,
                challenger=challenger and challenger["event"]["candidate"], shadow_done=shadow_done, shadow_need=shadow_n,
                ref_start=rows[reference[0]]["date"], ref_end=rows[reference[1]]["date"], cur_start=rows[ridx-current_n+1]["date"]))
            if pace:
                time.sleep(pace)
            if (k-first) % 5 == 0:
                self.ops.check_cancel(job_id)
            # ---- a challenger running in shadow: judged on the answers that matured since it started
            if challenger is not None and shadow_done >= shadow_n:
                sl = slice(challenger["k0"]+1, known_count)
                champion_scores, challenger_scores = scores(samples[sl], served[sl]), scores(samples[sl], candidate[sl])
                basis = snapshot("shadow", shadow_done, champion_scores, challenger_scores)
                ev = challenger["event"]
                ev["shadow"] = dict(decided_on=day, n=shadow_done, champion_wape=champion_scores["wape"], challenger_wape=challenger_scores["wape"],
                                    champion=champion_scores, challenger=challenger_scores, passed=basis["better"])
                self.store.append(live, dict(type="shadow_end", day=day, candidate=ev["candidate"], n=shadow_done, passed=basis["better"],
                                             champion_wape=champion_scores["wape"], challenger_wape=challenger_scores["wape"],
                                             champion_rmse=champion_scores["rmse"], challenger_rmse=challenger_scores["rmse"]))
                conclude(ev, challenger["bundle"], k, basis["better"],
                         f"섀도 {shadow_done}일: WAPE {champion_scores['wape']:.2f}% → {challenger_scores['wape']:.2f}% · RMSE {champion_scores['rmse']:.1f} → {challenger_scores['rmse']:.1f} · "
                         + ("둘 다 낮아져 교체" if basis["better"] else "둘 다 낮아지지 않아 유지"), basis)
                challenger = None
            # ---- trigger
            waited = None if last_tune is None else (date.fromisoformat(day)-date.fromisoformat(last_tune)).days
            if level < 2 or challenger is not None or (waited is not None and waited < cooldown_days) or tunes >= rules["max_tunes"]:
                continue
            if quality_open:
                if not holds or holds[-1]["quality_since"] != quality_log[-1]["start"]:
                    holds.append(dict(start=day, end=day, quality_since=quality_log[-1]["start"], reason="데이터 품질 문제 구간: 재학습 보류"))
                    self.ops.log("WARN", f"service period {job_id} {day}: 2단계 조건이지만 데이터 품질 문제로 재학습 보류")
                holds[-1]["end"] = day
                continue
            tunes += 1
            last_tune = day
            trigger = "both" if confirmed and wape_stage == 2 else "drift" if confirmed else "wape"
            cause = drift_cause(stats, timeline["cause_limits"]) if stats and timeline["cause_limits"] else None
            name = f"tuned_{job_id}_{tunes}"
            folder = self.root/"models"/name
            visible = [dict(row) for row in rows[:ridx+1]]
            self.store.append(live, dict(type="tune_start", day=day, wape=current, wape_limit=tune_limit, candidate=name, trigger=trigger, cause=cause,
                                         ks=ks_now, ks_limit=timeline["ks_limit"], ref_start=rows[reference[0]]["date"],
                                         ref_end=rows[reference[1]]["date"], before=serving_name, input_drift=bool(over)))
            notify("page", f"2단계 파인튜닝 시작 · {name}", f"트리거 {trigger}" + (f" · 원인 {cause['kind']}" if cause else ""), day)
            started = time.perf_counter()
            metadata = models.train_bundle(visible, folder, interval_days=DAILY, base=folders[serving_name],
                                           finetune=True, window_weeks=window_weeks, holdout_weeks=rules["lab_holdout_weeks"], synthetic=bool(shock),
                                           tune_epochs=rules["tune_epochs"], tune_lr=rules["tune_lr"], tune_patience=rules["tune_patience"])
            tuned = models.Bundle(folder)
            holdout = json.loads((folder/"evaluation.json").read_text())["validation"]
            hold_serving = scores(holdout, serving.predict_many([[v[0] for v in r["x"]] for r in holdout]))
            hold_tuned = scores(holdout, [r["prediction"] for r in holdout])
            passed = bool(metadata["gate"]["passed"] and hold_tuned["wape"] < hold_serving["wape"] and hold_tuned["rmse"] < hold_serving["rmse"])
            event = dict(gate_passed=passed, trigger=trigger, cause=cause, days_from_start=k-first, ks=ks_now, ks_limit=timeline["ks_limit"],
                         reference=dict(start=rows[reference[0]]["date"], end=rows[reference[1]]["date"]), day=day, wape=current,
                         wape_limit=warn_limit, wape_tune_limit=tune_limit, input_drift=bool(over), before=serving_name, candidate=name,
                         promoted=False, decision="진행 중", seconds=time.perf_counter()-started, shadow=None,
                         holdout=dict(serving=hold_serving, tuned=hold_tuned), gate=metadata["gate"], data_version=version(visible),
                         window_start=visible[-(window_weeks*7+rules["holdout_days"]):][0]["date"], epochs=metadata["epochs_run"])
            if k+1 < len(inputs):
                candidate[k+1:] = tuned.predict_many(inputs[k+1:])
            events.append(event)
            self.store.append(live, dict(type="tune_end", day=day, candidate=name, prescreen_passed=passed, serving_wape=hold_serving["wape"],
                                         tuned_wape=hold_tuned["wape"], serving_rmse=hold_serving["rmse"], tuned_rmse=hold_tuned["rmse"],
                                         seconds=event["seconds"], promotion=promotion))
            pre = (f"사전 검증(직전 {len(holdout)}일) WAPE {hold_serving['wape']:.2f}% → {hold_tuned['wape']:.2f}% · "
                   f"RMSE {hold_serving['rmse']:.1f} → {hold_tuned['rmse']:.1f}")
            basis = snapshot("prescreen", len(holdout), hold_serving, hold_tuned)
            if promotion == "always":
                conclude(event, tuned, k, True, f"{pre} · 항상 교체(비교용) 모드라 검증을 따르지 않음" + ("" if basis["better"] else " · 지표는 나빠졌음"), dict(basis, basis="forced"))
            elif not passed:
                conclude(event, tuned, k, False, f"{pre} · 사전 검증 탈락 (WAPE와 RMSE가 모두 낮아야 함)", basis)
            elif promotion == "gate":
                conclude(event, tuned, k, True, f"{pre} · 사전 검증 통과", basis)
            else:
                challenger = dict(event=event, bundle=tuned, k0=k)
                self.store.append(live, dict(type="shadow_start", day=day, candidate=name, need=shadow_n))
                self.ops.log("INFO", f"service period {job_id} {day}: {name} {pre} · 통과 → 섀도 운영 시작 (정답 {shadow_n}일치 확정까지 서비스하지 않음)")
        if challenger is not None:     # the period ended before the shadow had enough answers: nothing is promoted
            ev = challenger["event"]
            ev.update(decision=f"기간 종료 시점까지 섀도 {max(0, known_count-1-challenger['k0'])}/{shadow_n}일 — 판정 보류, 교체 안 함")
        # What the swap really did: from the day each model took over until the next swap, the model that was replaced is
        # scored on the same forecasts. This is hindsight, kept next to the numbers the swap was decided on.
        swaps = [(old_preds[e["candidate"]][0], e) for e in events if e["promoted"] and e["candidate"] in old_preds]
        for at, (k_swap, e) in enumerate(swaps):
            lo, hi = k_swap+1, (swaps[at+1][0] if at+1 < len(swaps) else last)+1
            if hi-lo >= 3:
                kept, now_scores = scores(samples[lo:hi], old_preds[e["candidate"]][1][:hi-lo]), scores(samples[lo:hi], served[lo:hi])
                e["after"] = dict(days=hi-lo, from_day=issued[lo], to_day=issued[hi-1], old=kept, new=now_scores,
                                  wape_gain=kept["wape"]-now_scores["wape"], rmse_gain=kept["rmse"]-now_scores["rmse"],
                                  better=bool(now_scores["wape"] < kept["wape"] and now_scores["rmse"] < kept["rmse"]))
        for e in events:
            lineage.append(self.lineage_entry(job_id, e, window_weeks, promotion))
        self.store.append(live, dict(type="done"))
        part = slice(first, last+1)
        evaluated = samples[part]
        result = dict(id=job_id, kind="period", at=stamp(), start=start, end=end, promotion=promotion, warnings=warnings,
                      shock=shock and dict(shock, ramp_end=next((r["date"] for r in reversed(rows) if r.get("injected")), None)), limits=dict(warn=warn_limit, tune=tune_limit), config=self.config(),
                      signals=timeline["signals"], window_weeks=window_weeks, cooldown_days=cooldown_days, shadow_days=shadow_n,
                      unit=rows[0]["unit"], baseline=record["name"], events=events, holds=holds, quality=quality_log, lineage=lineage,
                      baseline_info=dict(trained_through=record["trained_through"], cutoff=record["cutoff"], refit=record.get("refit"),
                                         gate_passed=record["gate"]["passed"], gate=record["gate"], mode="처음부터 학습 (파인튜닝 아님)"), final_model=serving_name,
                      metrics=dict(fixed=scores(evaluated, fixed[part]), adaptive=scores(evaluated, served[part])))
        result["series"] = self.period_series(evaluated, actual[part], fixed[part], served[part], owner[first:last+1], timeline, known[part],
                                              np.asarray([x for x in actual]), fixed, served, known, issued[first:last+1], window, candidate)
        result["series"]["candidate"] = [round(float(v), 3) if np.isfinite(v) else None for v in candidate[part]]
        result["slo"] = dict(target=slo_target*100, limit=warn_limit, fixed=slo_report(result["series"]["wape_fixed"], warn_limit, slo_target),
                             adaptive=slo_report(result["series"]["wape_adaptive"], warn_limit, slo_target))
        compare = np.isfinite(candidate[part])
        if compare.any():    # the three models on the days after the first fine-tune: shows the gap even when nothing was promoted
            subset = np.asarray(evaluated, dtype=object)[compare].tolist()
            result["shadow"] = dict(days=int(compare.sum()), since=result["series"]["issued_at"][int(np.argmax(compare))],
                                    fixed=scores(subset, fixed[part][compare]), adaptive=scores(subset, served[part][compare]),
                                    candidate=scores(subset, candidate[part][compare]))
        interval = wape_gap_interval(actual[part], fixed[part], served[part])
        gain = result["metrics"]["fixed"]["wape"]-result["metrics"]["adaptive"]["wape"]
        code = "no_trigger" if not events else "better" if interval[0] > 0 else "worse" if interval[1] < 0 else "inconclusive"
        result["verdict"] = dict(code=code, wape_gain=gain, rmse_gain=result["metrics"]["fixed"]["rmse"]-result["metrics"]["adaptive"]["rmse"],
                                 interval=interval, win_rate=float(np.mean(np.abs(actual[part]-fixed[part]) > np.abs(actual[part]-served[part]))*100),
                                 tunes=len(events), promoted=sum(e["promoted"] for e in events))
        result["episodes"] = [e for e in timeline["episodes"] if e["end"] >= start and e["start"] <= end]
        result["timing"] = self.timing(evaluated, actual[part], fixed[part], served[part], result["series"], timeline["wape_limit"], timeline["signals"])
        result["causes"] = self.cause_history(events)
        self.store.append("service_replays", result)
        self.ops.log("INFO", f"service period {job_id} done: {code}, 파인튜닝 {len(events)}회 · 교체 {result['verdict']['promoted']}회")
        return dict(id=job_id, tuned=bool(events), verdict=code, tunes=len(events))

    def lineage_entry(self, job_id, event, window_weeks, promotion):
        """Everything needed to reproduce and audit one model: parent, trigger, data window, checks and who let it through."""
        shadow = event.get("shadow")
        gain = None if not shadow else shadow["champion_wape"]-shadow["challenger_wape"]
        entry = dict(model=event["candidate"], registry=event.get("registry_version"), parent=event["before"], job_id=job_id, day=event["day"], trigger=event["trigger"],
                     cause=(event.get("cause") or {}).get("kind"), ks=event["ks"], wape=event["wape"],
                     reference_window=event["reference"], train_window=dict(start=event["window_start"], end=event["day"]),
                     window_weeks=window_weeks, epochs=event.get("epochs"), learning_rate=RULES["gate"]["finetune"]["learning_rate"],
                     data_version=event.get("data_version"), prescreen=event["holdout"], prescreen_passed=event["gate_passed"],
                     shadow=shadow, promotion=promotion, promoted=event["promoted"], decision_metrics=event.get("decision_metrics"), after=event.get("after"), decided_on=event.get("decided_on"),
                     decision=event["decision"], wape_gain=gain, cost_seconds=event["seconds"], at=stamp())
        self.store.append("service_lineage", entry)
        return entry

    def cause_history(self, events):
        """How often fine-tuning actually replaced the model, per kind of drift - over this run and every earlier one."""
        table = {}
        for run in self.store.read("service_replays"):
            for e in run.get("events", []) if run.get("kind") == "period" else []:
                if e.get("cause"):
                    row = table.setdefault(e["cause"]["kind"], dict(n=0, promoted=0))
                    row["n"] += 1
                    row["promoted"] += bool(e.get("promoted"))
        for e in events:
            if e.get("cause"):
                row = table.setdefault(e["cause"]["kind"], dict(n=0, promoted=0))
                row["n"] += 1
                row["promoted"] += bool(e["promoted"])
        return table

    def period_series(self, evaluated, actual, fixed, served, owner, timeline, known_part, all_actual, all_fixed, all_served, all_known, issued, window, all_candidate):
        """Per-day chart data: forecasts vs reality, both models' trailing 28-day WAPE, and the running advantage."""
        def trailing(predicted):
            values = []
            for day in issued:
                count = bisect.bisect_right(all_known, day)
                part = slice(count-window, count)
                values.append(None if count < window or not np.isfinite(predicted[part]).all() else round(float(np.abs(all_actual[part]-predicted[part]).sum()/all_actual[part].sum()*100), 3))
            return values
        gain = np.abs(actual-fixed)-np.abs(actual-served)
        blocks = []
        for start in range(0, len(evaluated), 28):
            part = slice(start, start+28)
            blocks.append(dict(start=evaluated[start]["issued_at"], end=evaluated[min(start+27, len(evaluated)-1)]["issued_at"],
                               base=float(np.abs(actual[part]-fixed[part]).sum()/actual[part].sum()*100),
                               tuned=float(np.abs(actual[part]-served[part]).sum()/actual[part].sum()*100)))
        return dict(issued_at=issued, target_date=[s["target_date"] for s in evaluated],
                    actual=[round(float(v), 3) for v in actual], fixed=[round(float(v), 3) for v in fixed],
                    adaptive=[round(float(v), 3) for v in served], owner=owner,
                    wape_fixed=trailing(all_fixed), wape_adaptive=trailing(all_served), wape_candidate=trailing(all_candidate),
                    advantage=[round(float(v), 3) for v in np.cumsum(gain)], blocks=blocks)

    def timing(self, evaluated, actual, fixed, served, series, wape_limit, signals):
        """Daily purchase timing from each model's 4-week forecast, checked against what the price really did."""
        last = np.asarray([s["x"][-1][0] for s in evaluated])
        realized = ((actual/last-1)*100).tolist()
        reliable = [v is None or v <= wape_limit for v in series["wape_adaptive"]]
        out = dict(rules=signals, price=[round(float(v), 2) for v in last], realized=[round(v, 2) for v in realized],
                   reliable=reliable, unreliable_days=int(len(reliable)-sum(reliable)))
        for name, predicted in (("adaptive", served), ("fixed", fixed)):
            change = ((predicted/last-1)*100).tolist()
            levels = [signal_level(c, signals) for c in change]
            out[name] = dict(change=[round(c, 2) for c in change], levels=levels, stats=signal_stats(levels, change, realized, signals),
                             windows=signal_windows(series["issued_at"], levels, change, realized, reliable, signals))
        return out

    def verdict(self, result):
        after = result["metrics"]["after"]
        if "tuned" not in after:
            return dict(code="healthy", wape_gain=None, interval=None)
        actual = result["series"]["actual"]
        interval = wape_gap_interval(actual, result["series"]["base"], result["series"]["tuned"])
        gain = after["base"]["wape"]-after["tuned"]["wape"]
        code = "better" if interval[0] > 0 else "worse" if interval[1] < 0 else "inconclusive"
        return dict(code=code, wape_gain=gain, rmse_gain=after["base"]["rmse"]-after["tuned"]["rmse"], interval=interval,
                    win_rate=result["series"]["win_rate"])

    def comparison(self, evaluation, base_predicted, tuned_predicted, rows, day):
        """Chart-ready series: forecasts against what really happened, weekly error and the running advantage."""
        actual = np.asarray([s["actual"] for s in evaluation])
        series = dict(issued_at=[s["issued_at"] for s in evaluation], target_date=[s["target_date"] for s in evaluation],
                      actual=[round(float(v), 3) for v in actual], base=[round(float(v), 3) for v in base_predicted])
        weekly = []
        for start in range(0, len(evaluation), 7):
            part = slice(start, start+7)
            entry = dict(start=evaluation[start]["target_date"], end=evaluation[min(start+6, len(evaluation)-1)]["target_date"],
                         base=float(np.abs(actual[part]-base_predicted[part]).sum()/actual[part].sum()*100))
            if tuned_predicted is not None:
                entry["tuned"] = float(np.abs(actual[part]-tuned_predicted[part]).sum()/actual[part].sum()*100)
            weekly.append(entry)
        if tuned_predicted is not None:
            gain = np.abs(actual-base_predicted)-np.abs(actual-tuned_predicted)
            series.update(tuned=[round(float(v), 3) for v in tuned_predicted],
                          advantage=[round(float(v), 3) for v in np.cumsum(gain)],
                          win_rate=float(np.mean(gain > 0)*100))
        index = next(i for i, row in enumerate(rows) if row["date"] == day)
        axis = rows[max(0, index-90):]
        reach = max(series["target_date"], default=day)
        axis = [row for row in axis if row["date"] <= reach]
        by_target = {s["target_date"]: i for i, s in enumerate(evaluation)}
        context = dict(dates=[row["date"] for row in axis], price=[round(row["midpoint"], 2) for row in axis],
                       base=[series["base"][by_target[row["date"]]] if row["date"] in by_target else None for row in axis],
                       tuned=[series["tuned"][by_target[row["date"]]] if tuned_predicted is not None and row["date"] in by_target else None
                              for row in axis],
                       t_index=next(i for i, row in enumerate(axis) if row["date"] == day))
        return dict(series=series, weekly=weekly, context=context)
