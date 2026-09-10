import asyncio
import json
import multiprocessing
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import pytest

from server import db
from server.request_limits import cap_detail_items, parse_workspace_ids, validate_date_range
from server.routers import (
    aiml,
    apps,
    aws_actual,
    azure_actual,
    billing,
    dbsql_base,
    gcp_actual,
    tagging,
    users_groups,
)


class _Cursor:
    description = [("value",)]

    def __init__(self, execute, rows=None):
        self._execute = execute
        self._rows = list(rows or [(1,)])
        self._offset = 0

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def execute(self, *_args):
        self._execute(self)

    def fetchmany(self, size):
        batch = self._rows[self._offset : self._offset + size]
        self._offset += len(batch)
        return batch

    def cancel(self):
        return None


class _Connection:
    def __init__(self, cursor):
        self._cursor = cursor

    def cursor(self):
        return self._cursor

    def close(self):
        return None


@contextmanager
def _connection_factory(execute, rows=None):
    yield _Connection(_Cursor(execute, rows))


@pytest.fixture
def small_sql_executor(monkeypatch):
    original_executor = db._sql_executor
    original_admission = db._sql_admission
    executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="test-sql")
    monkeypatch.setattr(db, "_sql_executor", executor)
    monkeypatch.setattr(db, "_sql_admission", threading.BoundedSemaphore(3))
    monkeypatch.setattr(db, "SQL_EXECUTOR_MAX_WORKERS", 2)
    monkeypatch.setattr(db, "SQL_EXECUTOR_QUEUE_CAPACITY", 1)
    with db._sql_metrics_lock:
        for key in db._sql_metrics:
            db._sql_metrics[key] = 0
    yield executor
    db._sql_executor = original_executor
    db._sql_admission = original_admission
    executor.shutdown(wait=True, cancel_futures=True)


def test_sql_admission_bounds_active_work_and_rejects_quickly(monkeypatch, small_sql_executor):
    release = threading.Event()
    two_active = threading.Event()
    state_lock = threading.Lock()
    state = {"active": 0, "peak": 0}

    def execute(_cursor):
        with state_lock:
            state["active"] += 1
            state["peak"] = max(state["peak"], state["active"])
            if state["active"] == 2:
                two_active.set()
        assert release.wait(timeout=2)
        with state_lock:
            state["active"] -= 1

    monkeypatch.setattr(db, "get_connection", lambda: _connection_factory(execute))
    with ThreadPoolExecutor(max_workers=4) as callers:
        pending = [
            callers.submit(db.execute_query, f"SELECT {index}", no_cache=True) for index in range(3)
        ]
        assert two_active.wait(timeout=1)
        started = time.monotonic()
        with pytest.raises(db.SQLOverloadedError):
            db.execute_query("SELECT overload", no_cache=True)
        assert time.monotonic() - started < 0.2
        release.set()
        assert all(future.result(timeout=2) == [{"value": 1}] for future in pending)

    assert state["peak"] == 2
    assert db.get_sql_executor_metrics()["rejected"] == 1


def test_timeout_cancels_connector_and_capacity_recovers(monkeypatch):
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="test-timeout")
    monkeypatch.setattr(db, "_sql_executor", executor)
    monkeypatch.setattr(db, "_sql_admission", threading.BoundedSemaphore(1))
    cancelled = threading.Event()

    class CancelCursor(_Cursor):
        def cancel(self):
            cancelled.set()

    @contextmanager
    def slow_connection():
        cursor = CancelCursor(lambda _cursor: cancelled.wait(timeout=2))
        yield _Connection(cursor)

    monkeypatch.setattr(db, "get_connection", slow_connection)
    with pytest.raises(db.SQLTimeoutError):
        db.execute_query("SELECT slow", no_cache=True, timeout=0.05)
    assert cancelled.wait(timeout=1)

    deadline = time.monotonic() + 1
    while db.get_sql_executor_metrics()["active"] and time.monotonic() < deadline:
        time.sleep(0.01)

    monkeypatch.setattr(
        db,
        "get_connection",
        lambda: _connection_factory(lambda _cursor: None),
    )
    assert db.execute_query("SELECT recovered", no_cache=True) == [{"value": 1}]
    executor.shutdown(wait=True, cancel_futures=True)


def test_named_sql_operation_can_be_cancelled(monkeypatch):
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="test-cancel")
    monkeypatch.setattr(db, "_sql_executor", executor)
    monkeypatch.setattr(db, "_sql_admission", threading.BoundedSemaphore(1))
    started = threading.Event()
    cancelled = threading.Event()

    class CancelCursor(_Cursor):
        def cancel(self):
            cancelled.set()

    @contextmanager
    def slow_connection():
        def execute(_cursor):
            started.set()
            cancelled.wait(timeout=2)
            if cancelled.is_set():
                raise RuntimeError("cancelled")

        yield _Connection(CancelCursor(execute))

    monkeypatch.setattr(db, "get_connection", slow_connection)
    with ThreadPoolExecutor(max_workers=1) as caller:
        future = caller.submit(
            db.execute_query,
            "SELECT slow",
            no_cache=True,
            operation_id="setup-run",
        )
        assert started.wait(timeout=1)
        assert db.cancel_sql_operation("setup-run") == 1
        assert cancelled.wait(timeout=1)
        with pytest.raises(RuntimeError, match="cancelled"):
            future.result(timeout=2)

    assert db.cancel_sql_operation("setup-run") == 0
    executor.shutdown(wait=True, cancel_futures=True)


def test_identical_cache_misses_share_one_sql_producer(monkeypatch, small_sql_executor):
    started = threading.Event()
    release = threading.Event()
    executions = 0
    state_lock = threading.Lock()

    def execute(_cursor):
        nonlocal executions
        with state_lock:
            executions += 1
        started.set()
        assert release.wait(timeout=2)

    monkeypatch.setattr(db, "get_connection", lambda: _connection_factory(execute))
    db.clear_query_cache("coalesce-cloud")
    with ThreadPoolExecutor(max_workers=2) as callers:
        first = callers.submit(
            db.execute_query,
            "SELECT 'coalesce-cloud'",
            cache_tag="coalesce-cloud",
        )
        assert started.wait(timeout=1)
        second = callers.submit(
            db.execute_query,
            "SELECT 'coalesce-cloud'",
            cache_tag="coalesce-cloud",
        )
        deadline = time.monotonic() + 1
        while db.get_sql_executor_metrics()["coalesced"] < 1 and time.monotonic() < deadline:
            time.sleep(0.01)
        release.set()
        assert first.result(timeout=2) == [{"value": 1}]
        assert second.result(timeout=2) == [{"value": 1}]

    assert executions == 1
    assert not db._query_inflight


def test_two_worker_bundle_reserves_one_worker_for_fair_progress(monkeypatch, small_sql_executor):
    first_started = threading.Event()
    release_first = threading.Event()
    active = 0
    peak = 0
    state_lock = threading.Lock()

    def query(index):
        def run():
            nonlocal active, peak
            with state_lock:
                active += 1
                peak = max(peak, active)
            if index == 0:
                first_started.set()
                assert release_first.wait(timeout=2)
            with state_lock:
                active -= 1
            return [{"value": index}]

        return run

    with ThreadPoolExecutor(max_workers=1) as caller:
        bundle = caller.submit(
            db.execute_queries_parallel,
            [(f"cloud-{index}", query(index)) for index in range(4)],
            2,
        )
        assert first_started.wait(timeout=1)
        # The bundle owns one slot; an unrelated query can use the reserved worker.
        unrelated = db._submit_sql_future(
            lambda: [{"value": "other"}],
            label="unrelated",
        )[0]
        assert unrelated.result(timeout=1) == [{"value": "other"}]
        release_first.set()
        result = bundle.result(timeout=2)

    assert len(result) == 4
    assert peak == 1
    assert db.get_sql_executor_metrics()["active"] == 0
    assert db.get_sql_executor_metrics()["queued"] == 0


def test_nested_execute_query_reuses_outer_admission(monkeypatch):
    monkeypatch.setattr(db._sql_executor_local, "in_worker", True, raising=False)
    monkeypatch.setattr(db, "_sql_admission", threading.BoundedSemaphore(0))
    monkeypatch.setattr(
        db,
        "get_connection",
        lambda: _connection_factory(lambda _cursor: None),
    )

    assert db.execute_query("SELECT nested", no_cache=True) == [{"value": 1}]


def test_required_bundle_queries_run_before_optional_detail(monkeypatch):
    monkeypatch.setattr(db._sql_executor_local, "in_worker", True, raising=False)
    order = []
    results, failures = db.execute_bundle_queries(
        [
            ("detail", lambda: order.append("detail") or []),
            ("summary", lambda: order.append("summary") or [{"total": 1}]),
        ],
        required_names={"summary"},
        timeout=1,
    )

    assert order == ["summary", "detail"]
    assert results["summary"] == [{"total": 1}]
    assert failures == {}


def test_capacity_failure_is_not_cached_or_left_inflight(monkeypatch):
    monkeypatch.setattr(db, "_sql_admission", threading.BoundedSemaphore(0))
    db.clear_query_cache("capacity-not-cacheable")

    for _ in range(2):
        with pytest.raises(db.SQLOverloadedError):
            db.execute_query(
                "SELECT 'capacity-not-cacheable'",
                cache_tag="capacity-not-cacheable",
            )
        assert not db._query_inflight


def test_sql_row_and_byte_caps_fail_closed(monkeypatch):
    monkeypatch.setattr(
        db,
        "get_connection",
        lambda: _connection_factory(
            lambda _cursor: None,
            rows=[("a",), ("b",), ("c",)],
        ),
    )
    with pytest.raises(db.SQLResultLimitError) as row_error:
        db.execute_query("SELECT rows", no_cache=True, max_rows=2)
    assert row_error.value.limit_name == "row"

    monkeypatch.setattr(
        db,
        "get_connection",
        lambda: _connection_factory(
            lambda _cursor: None,
            rows=[("x" * 2000,)],
        ),
    )
    with pytest.raises(db.SQLResultLimitError) as byte_error:
        db.execute_query("SELECT bytes", no_cache=True, max_bytes=1024)
    assert byte_error.value.limit_name == "response byte"


def test_default_capacity_accepts_large_aggregate_intermediate(monkeypatch):
    assert db.SQL_MAX_RESULT_ROWS >= 150_000
    assert db.SQL_MAX_RESULT_BYTES >= 64 * 1024 * 1024
    rows = [(index,) for index in range(100_001)]
    monkeypatch.setattr(
        db,
        "get_connection",
        lambda: _connection_factory(lambda _cursor: None, rows=rows),
    )

    result = db.execute_query("SELECT aggregate rows", no_cache=True)

    assert len(result) == 100_001
    limited, metadata = cap_detail_items(result, max_rows=25)
    assert len(limited) == 25
    assert metadata["truncated"] is True


@pytest.mark.parametrize(
    "failure",
    [
        db.SQLOverloadedError("full"),
        db.SQLTimeoutError("slow"),
        db.SQLResultLimitError("row", 1),
    ],
)
def test_parallel_executor_propagates_typed_infrastructure_failures(monkeypatch, failure):
    monkeypatch.setattr(db._sql_executor_local, "in_worker", True, raising=False)

    def fail():
        raise failure

    with pytest.raises(type(failure)) as exc:
        db.execute_queries_parallel([("required", fail)], timeout=0.1)
    assert exc.value.query_name == "required"
    assert exc.value.partial_results == {}


def test_optional_bundle_failure_keeps_partial_results_and_reason(monkeypatch):
    monkeypatch.setattr(db._sql_executor_local, "in_worker", True, raising=False)
    failure = db.SQLTimeoutError("optional timeout")

    def fail():
        raise failure

    with pytest.raises(db.SQLTimeoutError) as exc:
        db.execute_queries_parallel(
            [("required", lambda: [{"ok": True}]), ("optional", fail)],
            timeout=0.1,
        )
    results, reasons = db.recover_optional_bundle_queries(exc.value, {"required"})
    assert results["required"] == [{"ok": True}]
    assert reasons == {"optional": "SQL_TIMEOUT"}


def test_request_and_detail_limits_preserve_separate_totals():
    assert parse_workspace_ids("1,2,1") == ["1", "2"]
    with pytest.raises(Exception):
        validate_date_range(
            "2020-01-01",
            "2026-01-01",
            default_start="2026-01-01",
            default_end="2026-01-02",
        )

    authoritative_total = 1234.5
    limited, metadata = cap_detail_items(
        [{"value": index} for index in range(5)],
        max_rows=2,
        max_bytes=1024,
    )
    response = {"items": limited, "total": authoritative_total, "limits": metadata}
    assert len(response["items"]) == 2
    assert response["total"] == 1234.5
    assert response["limits"]["truncated"] is True


@pytest.mark.parametrize(
    ("start_date", "end_date", "too_early"),
    [
        ("2025-02-28", "2025-08-28", "2025-02-27"),
        ("2025-07-30", "2026-01-30", "2025-07-29"),
    ],
)
def test_six_calendar_month_contract_at_august_and_january_boundaries(
    start_date, end_date, too_early
):
    defaults = {"default_start": start_date, "default_end": end_date}
    assert validate_date_range(start_date, end_date, **defaults) == (
        start_date,
        end_date,
    )
    with pytest.raises(Exception, match="6 calendar months"):
        validate_date_range(too_early, end_date, **defaults)


def test_dashboard_bundle_routes_share_today_rejection_contract():
    today = datetime.now(timezone.utc).date().isoformat()
    dbsql_router = dbsql_base.create_dbsql_router("dbsql_cost_per_query")
    dbsql_endpoint = next(
        route.endpoint for route in dbsql_router.routes if route.path == "/dashboard-bundle"
    )
    calls = [
        lambda: apps.get_apps_dashboard_bundle(today, today, False, None),
        lambda: aiml.get_aiml_dashboard_bundle(today, today, None),
        lambda: tagging.get_tagging_dashboard_bundle(today, today, None),
        lambda: billing.get_dashboard_bundle_fast(today, today, None),
        lambda: users_groups.get_users_groups_bundle(today, today, None, None),
        lambda: aws_actual.get_aws_actual_dashboard_bundle(today, today),
        lambda: azure_actual.get_azure_actual_dashboard_bundle(today, today),
        lambda: gcp_actual.get_gcp_actual_dashboard_bundle(today, today),
        lambda: dbsql_endpoint(today, today, None, None),
    ]
    for call in calls:
        with pytest.raises(Exception, match="yesterday or earlier"):
            asyncio.run(call())


def _lease_process(lease_dir, start, release, results):
    db._BUNDLE_LEASE_DIR = lease_dir
    start.wait(timeout=5)
    lease = db.try_acquire_bundle_lease("same-bundle", lease_seconds=10)
    results.put(bool(lease))
    if lease is not None:
        release.wait(timeout=5)
        lease.release()


def test_same_bundle_key_across_processes_has_one_producer(tmp_path):
    ctx = multiprocessing.get_context("spawn")
    start = ctx.Event()
    release = ctx.Event()
    results = ctx.Queue()
    processes = [
        ctx.Process(
            target=_lease_process,
            args=(str(tmp_path), start, release, results),
        )
        for _ in range(2)
    ]
    for process in processes:
        process.start()
    start.set()
    acquired = [results.get(timeout=5), results.get(timeout=5)]
    assert acquired.count(True) == 1
    release.set()
    for process in processes:
        process.join(timeout=5)
        assert process.exitcode == 0


def test_expired_bundle_lease_is_recoverable(monkeypatch, tmp_path):
    monkeypatch.setattr(db, "_BUNDLE_LEASE_DIR", str(tmp_path))
    first = db.try_acquire_bundle_lease("recoverable", lease_seconds=1)
    assert first is not None
    assert db.try_acquire_bundle_lease("recoverable", lease_seconds=1) is None
    time.sleep(1.05)
    replacement = db.try_acquire_bundle_lease("recoverable", lease_seconds=1)
    assert replacement is not None
    replacement.release()


def test_deadline_releases_only_matching_local_bundle_owner(monkeypatch, tmp_path):
    monkeypatch.setattr(db, "_BUNDLE_LEASE_DIR", str(tmp_path))
    lease = db.try_acquire_bundle_lease(
        "deadline-owner",
        lease_seconds=90,
        hard_deadline_seconds=90,
    )
    assert lease is not None
    with open(lease.state_path) as state_file:
        state = json.load(state_file)
    state["deadline_at"] = time.time() - 1
    with open(lease.state_path, "w") as state_file:
        json.dump(state, state_file)
    with db._bundle_inflight_lock:
        db._bundle_inflight["deadline-owner"] = lease.owner

    failed = db.get_bundle_compute_state("deadline-owner")

    assert failed is not None
    assert failed["state"] == "failed"
    with db._bundle_inflight_lock:
        assert "deadline-owner" not in db._bundle_inflight


def test_wait_for_remote_reports_failure_and_removes_local_payload(monkeypatch, tmp_path):
    monkeypatch.setattr(db, "_BUNDLE_LEASE_DIR", str(tmp_path))
    lease = db.try_acquire_bundle_lease("remote-failure", lease_seconds=30)
    assert lease is not None
    owner_token = db._bundle_lease_owner.set(("remote-failure", lease.owner))
    write_token = db._bundle_remote_write_result.set(None)
    try:
        monkeypatch.setattr(db, "_ensure_response_cache_table", lambda: True)
        monkeypatch.setattr(db, "get_catalog_schema", lambda: ("catalog", "schema"))
        monkeypatch.setattr(
            db,
            "execute_query",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("write failed")),
        )

        written = db.delta_cache_put(
            "remote-failure",
            "apps:dashboard-bundle:v5:all",
            {"value": "private"},
            wait_for_remote=True,
        )

        assert written is False
        assert db._bundle_remote_write_result.get() is False
        assert "remote-failure" not in db._delta_l1
    finally:
        db._bundle_remote_write_result.reset(write_token)
        db._bundle_lease_owner.reset(owner_token)
        lease.release(succeeded=False)


def test_owner_expiring_during_remote_write_deletes_late_row(monkeypatch, tmp_path):
    monkeypatch.setattr(db, "_BUNDLE_LEASE_DIR", str(tmp_path))
    lease = db.try_acquire_bundle_lease("stolen-write", lease_seconds=30)
    assert lease is not None
    owner_token = db._bundle_lease_owner.set(("stolen-write", lease.owner))
    calls: list[str] = []

    def execute(sql, *_args, **_kwargs):
        calls.append(sql)
        if sql.startswith("MERGE"):
            with open(lease.state_path) as state_file:
                state = json.load(state_file)
            state["owner"] = "new-worker-owner"
            with open(lease.state_path, "w") as state_file:
                json.dump(state, state_file)
        return []

    try:
        monkeypatch.setattr(db, "_ensure_response_cache_table", lambda: True)
        monkeypatch.setattr(db, "get_catalog_schema", lambda: ("catalog", "schema"))
        monkeypatch.setattr(db, "execute_query", execute)

        written = db.delta_cache_put(
            "stolen-write",
            "apps:dashboard-bundle:v5:all",
            {"late": True},
            wait_for_remote=True,
        )

        assert written is False
        assert "stolen-write" not in db._delta_l1
        assert any(sql.startswith("DELETE FROM") and "cache_key = :key" in sql for sql in calls)
    finally:
        db._bundle_lease_owner.reset(owner_token)


def test_bundle_remote_write_failure_publishes_terminal_state(monkeypatch, tmp_path):
    monkeypatch.setattr(db, "_BUNDLE_LEASE_DIR", str(tmp_path))
    monkeypatch.setattr(db, "delta_cache_get", lambda _key: None)
    monkeypatch.setattr(db, "_ensure_response_cache_table", lambda: False)
    finished = threading.Event()

    def producer():
        assert (
            db.delta_cache_put(
                "required-remote",
                "users:dashboard-bundle:v4",
                {"available": True},
                wait_for_remote=True,
            )
            is False
        )
        finished.set()

    assert db.start_bundle_compute(
        "required-remote",
        producer,
        lease_seconds=30,
        hard_deadline_seconds=30,
    )
    assert finished.wait(timeout=2)
    deadline = time.monotonic() + 2
    state = None
    while time.monotonic() < deadline:
        state = db.get_bundle_compute_state("required-remote")
        if state and state.get("state") == "failed":
            break
        time.sleep(0.01)

    assert state is not None
    assert state["state"] == "failed"
    assert state["error_code"] == "BUNDLE_REMOTE_CACHE_WRITE_FAILED"


def test_active_bundle_renews_owner_fenced_lease(monkeypatch, tmp_path):
    monkeypatch.setattr(db, "_BUNDLE_LEASE_DIR", str(tmp_path))
    started = threading.Event()
    release = threading.Event()

    def slow_producer():
        started.set()
        assert release.wait(timeout=3)

    assert db.start_bundle_compute(
        "renewed-bundle",
        slow_producer,
        lease_seconds=1,
        name="renewal-test",
    )
    assert started.wait(timeout=1)
    time.sleep(1.2)
    assert db.try_acquire_bundle_lease("renewed-bundle", lease_seconds=1) is None
    release.set()

    deadline = time.monotonic() + 2
    replacement = None
    while replacement is None and time.monotonic() < deadline:
        replacement = db.try_acquire_bundle_lease("renewed-bundle", lease_seconds=1)
        if replacement is None:
            time.sleep(0.02)
    assert replacement is not None
    replacement.release()


def test_bounded_bundle_worker_preserves_request_context(monkeypatch, tmp_path):
    monkeypatch.setattr(db, "_BUNDLE_LEASE_DIR", str(tmp_path))
    finished = threading.Event()
    seen = {}
    source_token = db.set_source_labels(["shared-west"])
    user_token = db._user_token.set("request-token")
    try:

        def producer():
            seen["source_labels"] = db.selected_source_labels()
            seen["user_token"] = db._user_token.get()
            finished.set()

        assert db.start_bundle_compute("context-bundle", producer, lease_seconds=10)
        assert finished.wait(timeout=2)
    finally:
        db._user_token.reset(user_token)
        db.reset_source_labels(source_token)

    assert seen == {
        "source_labels": ["shared-west"],
        "user_token": "request-token",
    }


@pytest.mark.asyncio
async def test_delta_cache_read_does_not_block_event_loop():
    cache_started = threading.Event()

    def slow_cache(_key):
        cache_started.set()
        time.sleep(0.1)
        return {
            "summary": {"active_app_count": 0},
            "apps": {"active_count": 0, "active_window": {}},
            "cached": True,
        }

    with patch.object(apps, "delta_cache_get", side_effect=slow_cache):
        request = asyncio.create_task(
            apps.get_apps_dashboard_bundle(
                start_date="2026-08-01",
                end_date="2026-08-28",
                active_only=False,
                workspace_ids=None,
            )
        )
        assert await asyncio.to_thread(cache_started.wait, 1)
        started = time.monotonic()
        await asyncio.sleep(0.01)
        assert time.monotonic() - started < 0.05
        result = await request
        assert result["cached"] is True


def test_async_routes_never_call_delta_cache_get_directly():
    routers = Path(__file__).resolve().parents[1] / "routers"
    offenders = []
    for path in routers.glob("*.py"):
        for line_number, line in enumerate(path.read_text().splitlines(), 1):
            if "delta_cache_get(" not in line:
                continue
            if "to_thread(delta_cache_get" not in line:
                offenders.append(f"{path.name}:{line_number}")
    assert offenders == []
