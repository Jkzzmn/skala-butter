"""Data-quality faults must fail ingestion with a cause — they are not market drift."""
from fastapi.testclient import TestClient

from buttercast.app import create_app


def test_stale_source_opens_freshness_alert(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        ops = client.app.state.ops
        last = ops.dataset()["rows"][-1]["available_on"]
        ops.store.append("replay_clock", dict(as_of="2026-12-31"))  # weeks after the next expected release
        ops.collect()
        freshness = [a for a in client.get("/api/alerts").json() if a["key"] == "freshness"][0]
        assert freshness["status"] == "open"
        assert client.get("/api/datasets").json()["quality"]["freshness"] in ("stale", "current")
        assert last < "2026-12-31"
