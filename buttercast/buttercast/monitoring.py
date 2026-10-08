"""Price-only calibration and persistent observation-based alert state."""
import math

import numpy as np

from .data import version
from .metrics import drift, stamp

RETURN_UNIT = "log return"


def observation_windows(interval_days):
    return (180, 30) if interval_days == 1 else (52, 13)


def performance_window(interval_days):
    return 28 if interval_days == 1 else 13


def price_returns(rows):
    """Input drift is measured on the model's log returns, not trending price levels."""
    return np.diff(np.log([row["midpoint"] for row in rows])).tolist()


weekly_returns = price_returns  # Backwards-compatible public name.


def calibrate(rows, cutoff):
    past = [row for row in rows if row["available_on"] < cutoff]
    if not past:
        raise ValueError("보정 시점 이전 가격 없음")
    units = {row["unit"] for row in past}
    if len(units) != 1:
        raise ValueError("보정 가격 단위 혼합")
    unit = units.pop()
    interval_days = past[0].get("interval_days", 7)
    reference_n, current_n = observation_windows(interval_days)
    values = {"ks": [], "wasserstein": []}
    returns = price_returns(past)
    for end in range(reference_n+current_n, len(returns)+1):
        stats = drift(returns[:end], unit=RETURN_UNIT, reference_n=reference_n, current_n=current_n)
        for name in values:
            values[name].append(stats[name]["value"])
    return dict(input=values, unit=unit, start=past[0]["available_on"], end=past[-1]["available_on"],
                cutoff=cutoff, calibration_n=len(values["ks"]), data_version=version(past),
                feature=f"{interval_days}_day_log_return", interval_days=interval_days,
                reference_observations=reference_n, current_observations=current_n,
                rule_version="return_drift_95pct_two_new_observations_v3")


def evaluate_input(store, name, value, threshold, token, namespace, log=None):
    key = f"{name}@{namespace}"
    if value is None or threshold is None:
        return dict(key=key, value=value, threshold=threshold, token=token, count=0,
                    status="insufficient" if value is None else "uncalibrated", alert=False)
    if not math.isfinite(value) or not math.isfinite(threshold):
        raise ValueError("비유한 경보 지표 또는 임계값")
    with store.lock:
        checks = [row for row in store.read("input_checks") if row["key"] == key]
        previous = checks[-1] if checks else None
        if any(row["token"] == token for row in checks):
            return dict(previous, duplicate=True)
        exceeded = value > threshold
        count = previous["count"]+1 if previous and exceeded else 1 if exceeded else 0
        record = dict(key=key, value=value, threshold=threshold, token=token, count=count,
                      status="exceeded" if exceeded else "ok", alert=count >= 2, at=stamp())
        store.append("input_checks", record)
        latest = next((row for row in reversed(store.read("alerts")) if row["key"] == key), None)
        if count >= 2 and (latest is None or latest["status"] != "open"):
            store.append("alerts", dict(key=key, kind="input_drift", status="open", at=stamp(),
                                        severity="warning", token=token, namespace=namespace,
                                        message=f"{name} 새 관측 2회 연속 경계 초과", value=value, threshold=threshold))
            if log:
                log("WARN", f"input drift detected: {name}={value:.3f} > {threshold:.3f} 2회 연속 ({token})")
        elif not exceeded and latest and latest["status"] == "open":
            store.append("alerts", dict(latest, status="resolved", token=token, at=stamp(), message="경계 이내 복귀"))
            if log:
                log("INFO", f"input drift resolved: {name} 경계 이내 복귀 ({token})")
        return record
