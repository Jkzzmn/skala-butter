from datetime import date, timedelta

import pytest


def test_split_purges_future_labels_and_scaler_never_sees_test():
    from buttercast.models import prepare

    start = date(2010, 1, 1)
    rows = [dict(date=(start+timedelta(days=i*14)).isoformat(),
                 available_on=(start+timedelta(days=i*14+5)).isoformat(), midpoint=100+i)
            for i in range(140)]
    splits, scale = prepare(rows)
    assert max(r["actual_known_at"] for r in splits["train"]) < splits["validation"][0]["issued_at"]
    assert scale["max"] < 235
    rows[-1]["midpoint"] = 1000000
    assert prepare(rows)[1] == scale
    with pytest.raises(ValueError, match="104"):
        prepare(rows[:26])
