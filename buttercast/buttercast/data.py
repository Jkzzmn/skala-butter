import csv
import hashlib
import json
import math
import os
from datetime import date, timedelta
from pathlib import Path

# Price CSVs ship inside the repo (data/) so a container or Hugging Face Space needs nothing else.
AUDIT = Path(os.environ.get("BUTTERCAST_DATA_DIR", Path(__file__).resolve().parents[1] / "data"))
RULES = json.loads((Path(__file__).parent / "rules.json").read_text(encoding="utf-8"))


def check_units(rows):
    """Weekly ratios far outside real history mean mixed units, not market drift."""
    low, high = RULES["data_quality"]["min_weekly_ratio"], RULES["data_quality"]["max_weekly_ratio"]
    for a, b in zip(rows, rows[1:]):
        ratio = b["midpoint"]/a["midpoint"]
        if not low <= ratio <= high:
            raise ValueError(f"{b['date']} 주간 가격 비율 {ratio:.3f}: 단위 혼입 의심({low}~{high} 벗어남)")
    return rows


def load_eu(path):
    """Real weekly prices; +7 days is an explicit replay assumption, not publication evidence."""
    with Path(path).open(encoding="utf-8-sig", newline="") as file:
        reader = csv.DictReader(file)
        required = {"observation_date", "butter_eur_per_100kg", "source"}
        if not required.issubset(reader.fieldnames or []):
            raise ValueError("EU CSV 필수 날짜·가격·출처 열 누락")
        rows, seen = [], set()
        for index, row in enumerate(reader, 2):
            day = date.fromisoformat(row["observation_date"])
            price = float(row["butter_eur_per_100kg"])
            if day in seen or not math.isfinite(price) or price <= 0:
                raise ValueError(f"EU {index}행 중복 날짜 또는 유효하지 않은 가격")
            seen.add(day)
            rows.append(dict(date=day.isoformat(), midpoint=price, unit="EUR/100kg",
                             source=row["source"], synthetic=False, interval_days=7,
                             available_on=(day+timedelta(days=7)).isoformat(),
                             publication_verified=False,
                             availability_policy="historical_replay_assumed_observation_plus_7_days"))
    if not rows:
        raise ValueError("EU CSV 가격 없음")
    rows.sort(key=lambda row: row["date"])
    if any((date.fromisoformat(b["date"])-date.fromisoformat(a["date"])).days != 7
           for a, b in zip(rows, rows[1:])):
        raise ValueError("EU 주간 가격에 누락 구간이 있습니다. 보간하지 않습니다.")
    return check_units(rows)


def load_daily(path):
    """Load the generated 2016-2026 daily series used by the daily LSTM.

    Interpolated and carry-forward rows stay identifiable through `derived`; `synthetic`
    remains reserved for drift values injected by an isolated experiment.
    """
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    metadata, source_rows = payload.get("metadata", {}), payload.get("daily", [])
    rows, seen = [], set()
    for index, row in enumerate(source_rows, 1):
        try:
            day = date.fromisoformat(row["date"])
            price = float(row["price"])
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError(f"일일 가격 {index}행 날짜/가격 파싱 실패") from error
        if day in seen or not math.isfinite(price) or price <= 0:
            raise ValueError(f"일일 가격 {index}행 중복 날짜 또는 유효하지 않은 가격")
        seen.add(day)
        status = row.get("status", "")
        rows.append(dict(
            date=day.isoformat(), midpoint=price, unit="EUR/100kg",
            source=metadata.get("source_name", "European Commission MMO"),
            synthetic=False, derived=status != "공식 주간 관측값", value_status=status,
            interval_days=1, available_on=day.isoformat(), publication_verified=False,
            availability_policy="daily_series_from_weekly_observations",
        ))
    if not rows:
        raise ValueError("일일 가격 없음")
    rows.sort(key=lambda row: row["date"])
    if any((date.fromisoformat(b["date"])-date.fromisoformat(a["date"])).days != 1
           for a, b in zip(rows, rows[1:])):
        raise ValueError("일일 가격에 누락 구간이 있습니다")
    return check_units(rows)


def bundled_rows():
    return load_daily(AUDIT / "eu-butter-daily-2016-2026.json")


def version(rows):
    return hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest()[:12]


def quality(rows, as_of=None):
    as_of = as_of or date.today()
    days = [date.fromisoformat(r["date"]) for r in rows]
    interval = rows[0].get("interval_days", 14)
    gaps = [dict(after=a.isoformat(), before=b.isoformat(), days=(b-a).days)
            for a, b in zip(days, days[1:]) if (b-a).days != interval]
    latest = rows[-1]
    expected = date.fromisoformat(latest["available_on"])+timedelta(days=interval)
    delay = max(0, (as_of-expected).days)
    return dict(rows=len(rows), start=rows[0]["date"], end=latest["date"], gaps=gaps,
                missing_required=0, duplicates=0, missing_rate=0, invalid_units=0,
                next_expected_available=expected.isoformat(), delay_days=delay,
                freshness="stale" if delay else "current", interval_days=interval,
                schedule=f"{interval}일 관측 주기; 실제 발표 일정 미확인",
                availability_note=latest.get("availability_policy"), publication_verified=latest.get("publication_verified", False))
