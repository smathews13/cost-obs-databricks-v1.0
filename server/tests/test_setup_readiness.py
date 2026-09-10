"""Regression tests for the readiness check infrastructure in server/routers/setup.py.

Run with: pytest server/tests/test_setup_readiness.py -v
"""

import asyncio
import time
from concurrent.futures import Future
from concurrent.futures import TimeoutError as FutureTimeoutError
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import server.routers.setup as setup_mod
from server.routers.setup import (
    CheckStatus,
    TimedWarehouseCheckCache,
    WarehouseCheckResult,
    _get_or_start_warehouse_check_future,
    _safe_table_check_result,
    check_warehouse_readiness,
    reset_readiness_caches,
)


@pytest.fixture(autouse=True)
def clean_caches():
    """Reset all readiness caches before and after each test to prevent state leakage."""
    reset_readiness_caches()
    setup_mod._setup_confirmed_ready = False
    setup_mod._create_task_state.update(
        {
            "status": "idle",
            "error": None,
            "started_at": None,
            "started_at_epoch": None,
            "elapsed_seconds": None,
            "table_progress": {},
            "table_errors": {},
            "phase": "idle",
            "run_id": None,
            "revision": 0,
            "cancel_requested_at": None,
        }
    )
    yield
    reset_readiness_caches()
    setup_mod._setup_confirmed_ready = False


def _mock_token():
    """Return a MagicMock that satisfies ContextVar.set/reset protocol."""
    mock = MagicMock()
    mock.set.return_value = mock
    return mock


@pytest.mark.asyncio
async def test_setup_status_requires_wizard_when_storage_is_not_configured():
    with (
        patch.object(setup_mod, "_reconcile_task_state_from_disk"),
        patch.object(setup_mod, "get_catalog_schema", return_value=("", "")),
    ):
        result = await setup_mod.get_setup_status()

    assert result["status"] == "setup_required"
    assert not result["all_tables_exist"]


@pytest.mark.asyncio
async def test_stale_dbfs_completion_does_not_hide_missing_core_tables():
    tables = {name: True for name in setup_mod._CORE_REQUIRED_TABLES}
    missing = next(iter(setup_mod._CORE_REQUIRED_TABLES))
    tables[missing] = False

    with (
        patch.object(setup_mod, "_reconcile_task_state_from_disk"),
        patch.object(setup_mod, "get_catalog_schema", return_value=("cost_catalog", "cost_obs")),
        patch.object(setup_mod.os.path, "exists", return_value=False),
        patch("server.db.read_dbfs_setup_complete", return_value=True),
        patch.object(setup_mod, "check_materialized_views_exist", return_value=tables),
    ):
        result = await setup_mod.get_setup_status()

    assert result["status"] == "setup_required"
    assert missing in result["missing_tables"]


@pytest.mark.asyncio
async def test_existing_core_tables_recover_setup_after_git_redeploy():
    tables = {name: True for name in setup_mod._CORE_REQUIRED_TABLES}

    with (
        patch.object(setup_mod, "_reconcile_task_state_from_disk"),
        patch.object(setup_mod, "get_catalog_schema", return_value=("cost_catalog", "cost_obs")),
        patch.object(setup_mod.os.path, "exists", return_value=False),
        patch("server.db.read_dbfs_setup_complete", return_value=False),
        patch.object(setup_mod, "check_materialized_views_exist", return_value=tables),
        patch.object(setup_mod, "_restore_setup_completion_markers") as restore,
    ):
        result = await setup_mod.get_setup_status()

    assert result["status"] == "ready"
    assert result["recovered_from_tables"] is True
    assert setup_mod._setup_confirmed_ready is True
    restore.assert_called_once_with()


@pytest.mark.asyncio
async def test_cancel_table_creation_requests_sql_cancel_and_persists_state(tmp_path):
    setup_mod._create_task_state.update(
        {
            "status": "running",
            "run_id": "run-123",
            "phase": "creating_tables",
            "revision": 1,
        }
    )
    with (
        patch.object(setup_mod, "_TASK_CANCEL_DIR", str(tmp_path / "cancellations")),
        patch.object(setup_mod, "_reconcile_task_state_from_disk"),
        patch.object(
            setup_mod,
            "_require_setup_admin",
            new=AsyncMock(return_value="admin@example.com"),
        ),
        patch.object(setup_mod, "_persist_task_state") as persist,
        patch("server.db.cancel_sql_operation", return_value=3) as cancel_sql,
    ):
        result = await setup_mod.cancel_table_creation(MagicMock())

    assert result["status"] == "cancelling"
    assert result["cancelled_queries"] == 3
    assert setup_mod._create_task_state["phase"] == "cancelling"
    cancel_sql.assert_called_once_with("run-123")
    persist.assert_called_once()
    assert (tmp_path / "cancellations" / "run-123").exists()


@pytest.mark.asyncio
async def test_stalled_cancellation_never_allows_overlapping_retry():
    now = time.time()
    setup_mod._create_task_state.update(
        {
            "status": "cancelling",
            "run_id": "run-stalled",
            "phase": "cancelling",
            "started_at_epoch": now - 120,
            "cancel_requested_at": now - 91,
        }
    )
    with (
        patch.object(setup_mod, "_reconcile_task_state_from_disk"),
        patch.object(setup_mod, "get_catalog_schema", return_value=("catalog", "schema")),
        patch.object(setup_mod, "_persist_task_state") as persist,
    ):
        result = await setup_mod.get_setup_status()

    assert result["status"] == "initializing"
    assert result["task"]["status"] == "cancelling"
    assert result["task"]["phase"] == "cancellation_stalled"
    assert "overlapping writes" in result["task"]["error"]
    persist.assert_called_once()


@pytest.mark.asyncio
async def test_build_timeout_requests_cancel_and_keeps_retry_blocked():
    now = time.time()
    setup_mod._create_task_state.update(
        {
            "status": "running",
            "run_id": "run-timeout",
            "phase": "creating_tables",
            "started_at_epoch": now - setup_mod._BOOTSTRAP_TIMEOUT_SECONDS - 1,
        }
    )
    with (
        patch.object(setup_mod, "_reconcile_task_state_from_disk"),
        patch.object(setup_mod, "get_catalog_schema", return_value=("catalog", "schema")),
        patch.object(setup_mod, "_request_task_cancel") as request_cancel,
        patch.object(setup_mod, "_persist_task_state"),
        patch("server.db.cancel_sql_operation", return_value=1) as cancel_sql,
    ):
        result = await setup_mod.get_setup_status()

    assert result["status"] == "initializing"
    assert result["task"]["status"] == "cancelling"
    assert result["task"]["phase"] == "cancellation_stalled"
    request_cancel.assert_called_once_with("run-timeout")
    cancel_sql.assert_called_once_with("run-timeout")


def test_restore_converts_stale_cancelling_state_to_interrupted(tmp_path):
    task_file = tmp_path / "build_progress.json"
    task_file.write_text(
        '{"status":"cancelling","revision":7,"run_id":"run-old",'
        '"phase":"cancelling","table_progress":{},"table_errors":{}}'
    )
    with patch.object(setup_mod, "_TASK_STATE_FILE", str(task_file)):
        setup_mod._restore_task_state()

    assert setup_mod._create_task_state["status"] == "interrupted"
    assert setup_mod._create_task_state["phase"] == "interrupted"
    assert setup_mod._create_task_state["run_id"] == "run-old"


def test_cancelled_build_resets_progress_for_clean_retry(tmp_path):
    setup_mod._create_task_state.update(
        {
            "status": "running",
            "run_id": "run-456",
            "table_progress": {"daily_usage_summary": "running"},
            "table_errors": {"daily_usage_summary": "old error"},
        }
    )
    with (
        patch.object(setup_mod, "_TASK_CANCEL_DIR", str(tmp_path / "cancellations")),
        patch.object(setup_mod, "_persist_task_state"),
    ):
        setup_mod._request_task_cancel("run-456")
        setup_mod._create_tables_task("catalog", "schema", run_id="run-456")

    assert setup_mod._create_task_state["status"] == "cancelled"
    assert setup_mod._create_task_state["phase"] == "idle"
    assert setup_mod._create_task_state["table_progress"] == {}
    assert setup_mod._create_task_state["table_errors"] == {}


def test_reconcile_adopts_newer_error_detail_without_progress_change(tmp_path):
    task_file = tmp_path / "build_progress.json"
    task_file.write_text(
        '{"status":"running","revision":2,"phase":"creating_tables",'
        '"table_progress":{"daily_usage_summary":"error"},'
        '"table_errors":{"daily_usage_summary":"permission denied"},'
        '"run_id":"run-789"}'
    )
    setup_mod._create_task_state.update(
        {
            "status": "running",
            "revision": 1,
            "table_progress": {"daily_usage_summary": "running"},
            "table_errors": {},
            "run_id": "run-789",
        }
    )
    with patch.object(setup_mod, "_TASK_STATE_FILE", str(task_file)):
        setup_mod._reconcile_task_state_from_disk()

    assert setup_mod._create_task_state["table_progress"]["daily_usage_summary"] == "error"
    assert (
        setup_mod._create_task_state["table_errors"]["daily_usage_summary"] == "permission denied"
    )


def test_workspace_filter_save_fails_closed_when_delta_is_unavailable(tmp_path):
    class Request:
        headers: dict[str, str] = {}

        async def json(self):
            return {"workspace_ids": ["workspace-1"]}

    settings_path = tmp_path / "workspace_filter.json"
    with (
        patch.object(setup_mod, "SETTINGS_DIR", str(tmp_path)),
        patch.object(
            setup_mod,
            "_require_setup_admin",
            new=AsyncMock(return_value="admin@example.com"),
        ),
        patch(
            "server.routers.settings._load_settings_namespace",
            return_value=None,
        ),
        patch(
            "server.routers.settings.save_workspace_filter_to_table",
            side_effect=RuntimeError("Delta unavailable"),
        ),
    ):
        with pytest.raises(setup_mod.HTTPException) as exc:
            asyncio.run(setup_mod.save_workspace_filter(Request()))

    assert exc.value.status_code == 503
    assert "durable Delta storage" in exc.value.detail
    assert not settings_path.exists()


# ---------------------------------------------------------------------------
# Bug 2: cold-warehouse hang + single-flight
# ---------------------------------------------------------------------------


def test_warehouse_timeout_returns_quickly():
    """check_warehouse_readiness() must return TIMEOUT_STARTING immediately on timeout,
    not block for _WH_CHECK_TIMEOUT seconds.
    """
    slow_future: Future = Future()
    slow_future.result = MagicMock(side_effect=FutureTimeoutError())  # type: ignore[method-assign]

    with (
        patch.object(setup_mod, "_get_or_start_warehouse_check_future", return_value=slow_future),
        patch.object(setup_mod, "_get_cached_warehouse_check", return_value=None),
        patch.object(
            setup_mod, "_resolve_warehouse_config", return_value=("app_resource", "wh-123")
        ),
    ):
        start = time.monotonic()
        result = check_warehouse_readiness()
        elapsed = time.monotonic() - start

    assert result.status == CheckStatus.TIMEOUT_STARTING
    assert not result.ok
    assert elapsed < 2.0  # Must not hang — future.result mock raises immediately


def test_single_flight_reuses_inflight_future():
    """Two consecutive calls to _get_or_start_warehouse_check_future() while a future
    is in-flight must reuse that future — not start a second daemon thread.
    """
    thread_starts: list = []

    class _NoopThread:
        def __init__(self, *args, **kwargs):
            pass

        def start(self):
            thread_starts.append(1)

    with patch("server.routers.setup.threading.Thread", _NoopThread):
        f1 = _get_or_start_warehouse_check_future()
        f2 = _get_or_start_warehouse_check_future()  # Should reuse f1, not start again

    assert len(thread_starts) == 1, "Thread.start() should be called exactly once"
    assert f1 is f2


# ---------------------------------------------------------------------------
# Bug 4: typed failure classification + traceback logging
# ---------------------------------------------------------------------------


def test_blocking_warehouse_check_internal_error():
    """_run_blocking_warehouse_check() must classify an unexpected exception as
    INTERNAL_ERROR (not silently swallow it or mis-classify it).
    """
    with (
        patch("server.db.execute_query", side_effect=RuntimeError("unexpected crash")),
        patch("server.db._user_token", _mock_token()),
        patch.dict(
            setup_mod._run_blocking_warehouse_check.__globals__,
            {"_resolve_warehouse_config": lambda: ("app_resource", "wh-test")},
        ),
    ):
        result = setup_mod._run_blocking_warehouse_check()

    assert result.status == CheckStatus.INTERNAL_ERROR
    assert not result.ok
    assert "unexpected crash" in result.message


def test_safe_table_check_result_handles_exception():
    """_safe_table_check_result() must catch a future exception and return INTERNAL_ERROR
    rather than propagating the exception to the caller.
    """
    bad_future: Future = Future()
    bad_future.set_exception(RuntimeError("disk exploded"))

    ok, msg, status = _safe_table_check_result("system.billing.usage", bad_future)

    assert not ok
    assert status == CheckStatus.INTERNAL_ERROR
    assert "disk exploded" in msg


# ---------------------------------------------------------------------------
# Fix B: _run_blocking_warehouse_check guard
# ---------------------------------------------------------------------------


def test_blocking_warehouse_check_returns_not_configured_when_no_warehouse():
    """_run_blocking_warehouse_check must return NOT_CONFIGURED immediately when no
    warehouse is resolvable, not fall through to execute_query and produce a
    misleading connection error.
    """
    with patch.object(setup_mod, "_resolve_warehouse_config", return_value=("none", "")):
        result = setup_mod._run_blocking_warehouse_check()

    assert result.status == CheckStatus.NOT_CONFIGURED
    assert not result.ok
    assert result.source == "none"


# ---------------------------------------------------------------------------
# Fix C: NOT_CONFIGURED flows through the cache path
# ---------------------------------------------------------------------------


def test_not_configured_result_is_cached_with_long_ttl():
    """check_warehouse_readiness() must cache a NOT_CONFIGURED result so that the
    env var isn't re-read on every request.  TTL should be close to 3600 s.
    """
    with patch.object(setup_mod, "_resolve_warehouse_config", return_value=("none", "")):
        result1 = check_warehouse_readiness()

    assert result1.status == CheckStatus.NOT_CONFIGURED
    cached = setup_mod._wh_check_cache
    assert cached is not None, "NOT_CONFIGURED result was not written to cache"
    assert cached.is_valid()
    remaining_ttl = cached.expires_at - time.monotonic()
    assert remaining_ttl > 3500, f"Expected ~3600 s TTL, got {remaining_ttl:.0f} s"

    # Second call must hit cache — same object reference, no new thread started
    with patch(
        "server.routers.setup.threading.Thread",
        side_effect=AssertionError("Thread must not be started on cache hit"),
    ):
        result2 = check_warehouse_readiness()

    assert result2 is result1


# ---------------------------------------------------------------------------
# TOCTOU: table cache snapshot survives concurrent reset
# ---------------------------------------------------------------------------


def test_toctou_table_cache_snapshot_survives_concurrent_reset():
    """The cache fast-path must hold a snapshot of _table_readiness_cache so that a
    concurrent reset_readiness_caches() between the is-None check and the data access
    does not raise TypeError: 'NoneType' object is not subscriptable.
    """
    core_data = [
        {
            "table": "system.billing.usage",
            "name": "Usage",
            "granted": True,
            "description": "",
            "required": True,
            "category": "core",
        },
    ]
    wh_result = WarehouseCheckResult(
        status=CheckStatus.HEALTHY,
        ok=True,
        message="",
        warehouse_id="wh-1",
        source="app_resource",
    )
    setup_mod._table_readiness_cache = {"core": core_data, "enhanced": [], "sp_client_id": "sp-1"}
    setup_mod._table_readiness_cache_ts = time.monotonic()
    setup_mod._wh_check_cache = TimedWarehouseCheckCache(
        result=wh_result,
        expires_at=time.monotonic() + 300,
    )

    def reset_during_wh_check():
        """Simulates another thread calling reset_readiness_caches() at this exact
        moment — after the table cache snapshot is taken but before ["core"] is accessed."""
        setup_mod._table_readiness_cache = None  # nuclear reset mid-flight
        return wh_result

    with (
        patch.object(setup_mod, "_get_cached_warehouse_check", side_effect=reset_during_wh_check),
        patch.object(setup_mod, "_resolve_warehouse_config", return_value=("app_resource", "wh-1")),
    ):
        # Without the snapshot fix this raises TypeError: 'NoneType' is not subscriptable
        result = setup_mod._check_readiness_sync()

    assert result["core"] == core_data, "Snapshot was not used — global was read after reset"


# ---------------------------------------------------------------------------
# Cache management
# ---------------------------------------------------------------------------


def test_reset_readiness_caches_clears_all_state():
    """reset_readiness_caches() must zero out every cache field so the next request
    performs a full live check.
    """
    # Populate all fields
    setup_mod._table_readiness_cache = {"core": [], "enhanced": [], "sp_client_id": ""}
    setup_mod._table_readiness_cache_ts = time.monotonic()
    setup_mod._wh_check_cache = TimedWarehouseCheckCache(
        result=WarehouseCheckResult(status=CheckStatus.HEALTHY, ok=True, message=""),
        expires_at=time.monotonic() + 300,
    )
    dummy_future: Future = Future()
    with setup_mod._wh_check_lock:
        setup_mod._wh_check_inflight = dummy_future

    reset_readiness_caches()

    assert setup_mod._table_readiness_cache is None
    assert setup_mod._table_readiness_cache_ts == 0.0
    assert setup_mod._wh_check_cache is None
    assert setup_mod._wh_check_inflight is None
