"""Regression tests for the readiness check infrastructure in server/routers/setup.py.

Run with: pytest server/tests/test_setup_readiness.py -v
"""
import time
from concurrent.futures import Future, TimeoutError as FutureTimeoutError
from unittest.mock import MagicMock, patch

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
    yield
    reset_readiness_caches()


def _mock_token():
    """Return a MagicMock that satisfies ContextVar.set/reset protocol."""
    mock = MagicMock()
    mock.set.return_value = mock
    return mock


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
        patch.object(setup_mod, "_resolve_warehouse_config", return_value=("app_resource", "wh-123")),
    ):
        start = time.monotonic()
        result = check_warehouse_readiness()
        elapsed = time.monotonic() - start

    assert result.status == CheckStatus.TIMEOUT_STARTING
    assert not result.ok
    assert elapsed < 2.0  # Must not hang — future.result mock raises immediately


def test_single_flight_reuses_inflight_future():
    """Two consecutive calls to _get_or_start_warehouse_check_future() while a future
    is in-flight must reuse that future — not submit a second background task.
    """
    submitted_count = 0
    sentinel_future: Future = Future()  # Stays incomplete (not done)

    original_submit = setup_mod._wh_check_executor.submit

    def counting_submit(fn, *args, **kwargs):
        nonlocal submitted_count
        submitted_count += 1
        return sentinel_future

    with patch.object(setup_mod._wh_check_executor, "submit", side_effect=counting_submit):
        f1 = _get_or_start_warehouse_check_future()
        f2 = _get_or_start_warehouse_check_future()  # Should reuse f1, not submit again

    assert submitted_count == 1, "executor.submit should be called exactly once"
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
