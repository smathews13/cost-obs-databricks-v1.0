import asyncio
import base64
import gzip
import json
import multiprocessing
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import BackgroundTasks, HTTPException

from server import db
from server.queries import PLATFORM_KPIS_FAST
from server.routers import aiml, apps, billing, dbsql_base, health, settings, user


@pytest.fixture(autouse=True)
def declared_shared_source_tables(monkeypatch):
    tables = list(db.MV_UNIFIED_TABLE_NAMES)
    monkeypatch.setattr(
        db,
        "get_mv_sources",
        lambda: [
            {
                "label": label,
                "tables": tables,
                "workspace_ids": ["123", "456", "workspace-west"],
            }
            for label in ("shared", "shared-west", "shared-east", "shared-central")
        ],
    )
    monkeypatch.setattr(db, "get_local_source_label", lambda: "local")


class _Request:
    headers: dict[str, str] = {}

    def __init__(self, body: dict | None = None):
        self._body = body or {}

    async def json(self) -> dict:
        return self._body


class _CapturedThread:
    created: list["_CapturedThread"] = []

    def __init__(self, *, target, args=(), **_kwargs):
        self.target = target
        self.args = args
        self.created.append(self)

    def start(self):
        return None


class _ImmediateThread:
    def __init__(self, *, target, args=(), **_kwargs):
        self.target = target
        self.args = args

    def start(self):
        self.target(*self.args)


def test_user_payload_exposes_route_capabilities():
    request = SimpleNamespace(headers={"X-Forwarded-Email": "viewer@example.com"})
    with patch.object(user, "_get_user_role", return_value="consumer"):
        payload = asyncio.run(user.get_current_user(request))

    assert payload["role"] == "consumer"
    assert payload["capabilities"]["can_view_dashboards"] is True
    assert payload["capabilities"]["can_manage_settings"] is False
    assert payload["capabilities"]["can_manage_data"] is False


def test_settings_permissions_payload_includes_both_role_capabilities():
    request = SimpleNamespace(headers={"X-Forwarded-Email": "admin@example.com"})
    with (
        patch.object(
            settings,
            "_load_user_permissions",
            return_value={
                "admins": ["admin@example.com"],
                "consumers": ["viewer@example.com"],
            },
        ),
        patch("server.db.get_catalog_schema", return_value=("main", "cost_obs")),
    ):
        payload = asyncio.run(settings.get_user_permissions(request))

    assert payload["current_role"] == "admin"
    assert payload["role_capabilities"]["admin"]["can_manage_users"] is True
    assert payload["role_capabilities"]["consumer"]["can_manage_users"] is False


def _dashboard_endpoint(router):
    return next(route.endpoint for route in router.routes if route.path == "/dashboard-bundle")


def test_apps_background_thread_captures_request_context():
    apps._apps_bundle_inflight.clear()
    captured = {}

    def capture_start(_key, _producer, **_kwargs):
        captured["source_labels"] = db.selected_source_labels()
        captured["user_token"] = db._user_token.get()
        return False

    source_token = db.set_source_labels(["shared-west"])
    user_token = db._user_token.set("user-oauth-token")
    try:
        with (
            patch.object(apps, "delta_cache_get", return_value=None),
            patch.object(
                apps,
                "capture_cache_generation",
                return_value=db.CacheGeneration("apps:dashboard-bundle:v5:all", 0),
            ),
            patch.object(apps, "start_bundle_compute", side_effect=capture_start),
        ):
            asyncio.run(
                apps.get_apps_dashboard_bundle(
                    start_date="2026-08-01",
                    end_date="2026-08-28",
                    active_only=False,
                    workspace_ids=None,
                )
            )
        assert captured["source_labels"] == ["shared-west"]
        assert captured["user_token"] == "user-oauth-token"
    finally:
        db._user_token.reset(user_token)
        db.reset_source_labels(source_token)
        apps._apps_bundle_inflight.clear()


def test_aiml_background_thread_captures_request_context():
    captured = {}

    def capture_start(_key, _producer, **_kwargs):
        captured["source_labels"] = db.selected_source_labels()
        captured["user_token"] = db._user_token.get()
        return False

    source_token = db.set_source_labels(["shared-central"])
    user_token = db._user_token.set("aiml-user-token")
    try:
        with (
            patch.object(aiml, "delta_cache_get", return_value=None),
            patch.object(aiml, "get_bundle_compute_state", return_value=None),
            patch.object(aiml, "bundle_compute_is_pending", return_value=False),
            patch.object(
                aiml, "get_local_source_label", return_value="shared-central"
            ),
            patch.object(
                aiml,
                "capture_cache_generation",
                return_value=db.CacheGeneration("aiml:dashboard-bundle:v3", 0),
            ),
            patch.object(aiml, "start_bundle_compute", side_effect=capture_start),
        ):
            asyncio.run(
                aiml.get_aiml_dashboard_bundle(
                    start_date="2026-08-01",
                    end_date="2026-08-28",
                    workspace_ids=None,
                )
            )
        assert captured["source_labels"] == ["shared-central"]
        assert captured["user_token"] == "aiml-user-token"
    finally:
        db._user_token.reset(user_token)
        db.reset_source_labels(source_token)


def test_dbsql_background_thread_captures_request_context():
    dbsql_base._dbsql_bundle_inflight.clear()
    captured = {}

    def capture_start(_key, _producer, **_kwargs):
        captured["source_labels"] = db.selected_source_labels()
        captured["user_token"] = db._user_token.get()
        return False

    router = dbsql_base.create_dbsql_router("dbsql_cost_per_query")
    endpoint = _dashboard_endpoint(router)
    dbsql_base._mv_status_cache["dbsql_cost_per_query"] = (
        time.monotonic(),
        {"mv_available": True},
    )
    source_token = db.set_source_labels(["shared-east"])
    user_token = db._user_token.set("request-token")
    try:
        with (
            patch.object(dbsql_base, "delta_cache_get", return_value=None),
            patch.object(
                dbsql_base,
                "capture_cache_generation",
                return_value=db.CacheGeneration(
                    "dbsql:dbsql_cost_per_query:dashboard-bundle:v2", 0
                ),
            ),
            patch.object(
                dbsql_base, "start_bundle_compute", side_effect=capture_start
            ),
        ):
            asyncio.run(
                endpoint(
                    start_date="2026-08-01",
                    end_date="2026-08-28",
                    workspace_ids=None,
                )
            )
        assert captured["source_labels"] == ["shared-east"]
        assert captured["user_token"] == "request-token"
    finally:
        db._user_token.reset(user_token)
        db.reset_source_labels(source_token)
        dbsql_base._dbsql_bundle_inflight.clear()
        dbsql_base._mv_status_cache.clear()


def test_dbsql_mv_query_routes_and_filters_selected_source():
    template = dbsql_base._build_queries("dbsql_cost_per_query")["summary"]
    token = db.set_source_labels(["shared"])
    try:
        with (
            patch.object(
                db, "_list_existing_source_row_views", return_value=["dbsql_cost_per_query"]
            ),
            patch.object(
                db,
                "get_mv_sources",
                return_value=[{
                    "label": "shared",
                    "tables": ["dbsql_cost_per_query"],
                }],
            ),
            patch.object(db, "get_mv_table_overrides", return_value={}),
        ):
            query = dbsql_base._route_dbsql_mv_query(
                template,
                "catalog",
                "schema",
                "AND CAST(workspace_id AS STRING) IN ('123')",
            )
        assert "`catalog`.`schema`.`dbsql_cost_per_query__source_rows`" in query
        assert "source_label IN ('shared')" in query
        assert "CAST(workspace_id AS STRING) IN ('123')" in query
    finally:
        db.reset_source_labels(token)


def test_dbsql_mv_query_refuses_unfiltered_source_fallback():
    template = dbsql_base._build_queries("dbsql_cost_per_query")["summary"]
    token = db.set_source_labels(["shared"])
    try:
        with (
            patch.object(db, "_list_existing_source_row_views", return_value=[]),
            patch.object(
                db,
                "get_mv_sources",
                return_value=[{
                    "label": "shared",
                    "tables": ["dbsql_cost_per_query"],
                }],
            ),
            patch.object(db, "get_mv_table_overrides", return_value={}),
        ):
            with pytest.raises(RuntimeError, match="does not physically exist"):
                dbsql_base._route_dbsql_mv_query(template, "catalog", "schema")
    finally:
        db.reset_source_labels(token)


def test_dbsql_bundle_filters_warehouse_billing_and_region_counts():
    captured: list[str] = []
    router = dbsql_base.create_dbsql_router("dbsql_cost_per_query")
    endpoint = _dashboard_endpoint(router)
    compute_bundle = next(
        cell.cell_contents
        for cell in endpoint.__closure__ or ()
        if callable(cell.cell_contents)
        and getattr(cell.cell_contents, "__name__", "") == "_compute_dbsql_bundle"
    )
    dbsql_base._dbsql_bundle_inflight.clear()
    dbsql_base._mv_status_cache["dbsql_cost_per_query"] = (
        time.monotonic(),
        {"mv_available": True},
    )

    def execute(sql, *_args, **_kwargs):
        captured.append(sql)
        if "COUNT(DISTINCT u.workspace_id) AS ws_count" in sql:
            return [{"ws_count": 2}]
        if "COUNT(DISTINCT workspace_id) AS ws_count" in sql:
            return [{"ws_count": 0}]
        if "u.product_features.is_serverless" in sql:
            return [{
                "date": "2026-08-01",
                "warehouse_id": "w1",
                "is_serverless": True,
                "sql_tier": None,
                "sku_name": "PREMIUM_SQL_SERVERLESS",
                "daily_spend": 4,
            }]
        return []

    def sequential(queries, *_args, **_kwargs):
        return {name: fn() for name, fn in queries}

    with (
        patch.object(dbsql_base, "delta_cache_put") as cache_put,
        patch.object(dbsql_base, "get_catalog_schema", return_value=("c", "s")),
        patch.object(dbsql_base, "execute_query", side_effect=execute),
        patch.object(dbsql_base, "execute_queries_parallel", side_effect=sequential),
    ):
        compute_bundle(
            "2026-08-01",
            "2026-08-28",
            ["123", "456"],
            "123,456",
            "key",
            db.CacheGeneration(
                "dbsql:dbsql_cost_per_query:dashboard-bundle:v2", 0
            ),
        )

    scoped_live_queries = [
        sql for sql in captured
        if "system.billing.usage u" in sql or "system.compute.warehouses" in sql
    ]
    assert scoped_live_queries
    assert all(
        "('123', '456')" in sql or "('123','456')" in sql
        for sql in scoped_live_queries
    )
    response = cache_put.call_args.args[2]
    assert response["warehouse_type_timeseries"]["timeseries"][0]["SERVERLESS"] == 4
    assert response["warehouse_type_timeseries"]["sku_breakdown"] == [{
        "sku_name": "PREMIUM_SQL_SERVERLESS",
        "total_spend": 4.0,
    }]
    assert response["region_scope"]["billing_workspace_count"] == 2
    assert response["region_scope"]["in_region_workspace_count"] == 0
    assert response["region_scope"]["missing_workspace_count"] == 2
    assert response["region_scope"]["billing_sql_spend"] == 4
    assert response["region_scope"]["missing_region_sql_spend"] == 4
    assert response["region_scope"]["limited"] is True


def _reset_delta_l1():
    db._delta_l1.clear()
    db._delta_l1_endpoints.clear()
    db._delta_l1_generations.clear()


def test_cache_invalidation_rejects_worker_that_started_before_clear(tmp_path):
    _reset_delta_l1()
    with (
        patch.object(db, "_CACHE_GENERATION_STATE_PATH", str(tmp_path / "state.json")),
        patch.object(db, "_CACHE_GENERATION_LOCK_PATH", str(tmp_path / "lock")),
        patch.object(db, "get_catalog_schema", return_value=(None, None)),
    ):
        generation = db.capture_cache_generation("billing:kpis-bundle")
        db.delta_cache_invalidate("billing:kpis-bundle")
        accepted = db.delta_cache_put(
            "old-key",
            "billing:kpis-bundle",
            {"stale": True},
            generation=generation,
        )
    assert accepted is False
    assert "old-key" not in db._delta_l1


def _cache_generation_child(state_path: str, lock_path: str, connection):
    db._CACHE_GENERATION_STATE_PATH = state_path
    db._CACHE_GENERATION_LOCK_PATH = lock_path
    generation = db.capture_cache_generation("apps:dashboard-bundle:v5:all")
    connection.send("captured")
    connection.recv()
    accepted = db.delta_cache_put(
        "old-worker-key",
        "apps:dashboard-bundle:v5:all",
        {"stale": True},
        generation=generation,
    )
    connection.send(accepted)
    connection.close()


def test_cache_generation_fences_old_worker_across_processes(tmp_path):
    try:
        ctx = multiprocessing.get_context("fork")
    except ValueError:
        pytest.skip("cross-process cache generation test requires fork")
    state_path = str(tmp_path / "state.json")
    lock_path = str(tmp_path / "lock")
    parent, child = ctx.Pipe()
    with patch.object(db, "get_catalog_schema", return_value=(None, None)):
        process = ctx.Process(
            target=_cache_generation_child,
            args=(state_path, lock_path, child),
        )
        process.start()
        assert parent.recv() == "captured"
        with (
            patch.object(db, "_CACHE_GENERATION_STATE_PATH", state_path),
            patch.object(db, "_CACHE_GENERATION_LOCK_PATH", lock_path),
        ):
            db.delta_cache_invalidate("apps:")
        parent.send("continue")
        assert parent.recv() is False
        process.join(timeout=5)
    assert process.exitcode == 0


def test_blocked_delta_read_does_not_block_invalidate_or_return_stale(tmp_path):
    _reset_delta_l1()
    read_started = threading.Event()
    release_read = threading.Event()
    payload = base64.b64encode(
        gzip.compress(json.dumps({"stale": True}).encode())
    ).decode()

    def execute(sql, *_args, **_kwargs):
        if sql.lstrip().startswith("SELECT payload_json"):
            read_started.set()
            assert release_read.wait(timeout=2)
            return [{
                "payload_json": payload,
                "endpoint": "billing:kpis-bundle",
                "generation": 0,
            }]
        return []

    with (
        patch.object(db, "_CACHE_GENERATION_STATE_PATH", str(tmp_path / "state.json")),
        patch.object(db, "_CACHE_GENERATION_LOCK_PATH", str(tmp_path / "lock")),
        patch.object(db, "get_catalog_schema", return_value=("catalog", "schema")),
        patch.object(db, "execute_query", side_effect=execute),
    ):
        with ThreadPoolExecutor(max_workers=2) as executor:
            pending = executor.submit(db.delta_cache_get, "remote-key")
            assert read_started.wait(timeout=1)
            started = time.monotonic()
            db.delta_cache_invalidate("billing:")
            assert time.monotonic() - started < 0.5
            release_read.set()
            assert pending.result(timeout=2) is None
    assert "remote-key" not in db._delta_l1


@pytest.mark.parametrize(
    ("save_name", "table_save_name", "file_name", "payload"),
    [
        (
            "_save_webhook_settings",
            "_save_webhook_to_table",
            "WEBHOOK_SETTINGS_FILE",
            {"slack_webhook_url": "https://hooks.slack.com/test"},
        ),
        (
            "_save_alert_thresholds",
            "_save_alert_thresholds_to_table",
            "ALERT_THRESHOLDS_FILE",
            {"daily_budget": 100},
        ),
        (
            "_save_pricing_settings",
            "_save_pricing_to_table",
            "PRICING_SETTINGS_FILE",
            {"use_account_prices": True},
        ),
    ],
)
def test_settings_writes_keep_local_fallback_but_propagate_delta_failure(
    tmp_path, save_name, table_save_name, file_name, payload
):
    target = tmp_path / f"{file_name}.json"
    with (
        patch.object(settings, file_name, str(target)),
        patch.object(
            settings,
            table_save_name,
            side_effect=RuntimeError("Delta unavailable"),
        ),
    ):
        with pytest.raises(settings.AppSettingsDurabilityError):
            getattr(settings, save_name)(payload)
    assert target.exists()


def test_settings_namespace_replacements_are_atomic_and_isolated():
    writes: list[tuple[str, dict]] = []
    with (
        patch.object(settings, "_ensure_app_settings_table"),
        patch.object(settings, "_config_table", return_value="config_table"),
        patch(
            "server.db.execute_write",
            side_effect=lambda sql, params: writes.append((sql, params)),
        ),
    ):
        settings._save_webhook_to_table({"slack_webhook_url": ""})
        settings._save_alert_thresholds_to_table({"daily_budget": 10})
        settings._save_pricing_to_table({"use_account_prices": False})
    assert len(writes) == 3
    assert all("MERGE INTO config_table" in sql for sql, _ in writes)
    assert all("ON target.id = source.id" in sql for sql, _ in writes)
    assert all("INSERT OVERWRITE" not in sql for sql, _ in writes)
    assert [params["id"] for _, params in writes] == ["webhook", "alerts", "pricing"]


def test_settings_namespace_reads_only_its_named_row():
    with (
        patch.object(settings, "_config_table", return_value="config_table"),
        patch(
            "server.db.execute_query",
            return_value=[{"settings_json": '{"frequency":"weekly"}'}],
        ) as query,
    ):
        assert settings._load_settings_namespace("schedule") == {
            "frequency": "weekly"
        }

    sql, params = query.call_args.args[:2]
    assert "WHERE id = :id" in sql
    assert params == {"id": "schedule"}


def test_unified_put_returns_503_when_requested_group_is_not_durable():
    request = _Request({"webhook": {"slack_webhook_url": "https://example.invalid"}})
    with (
        patch.object(settings, "_require_admin"),
        patch.object(
            settings,
            "_save_webhook_settings",
            side_effect=settings.AppSettingsDurabilityError("Delta unavailable"),
        ),
    ):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(settings.put_unified_settings(request))
    assert exc.value.status_code == 503
    assert exc.value.detail["status"] == "partial_failure"
    assert exc.value.detail["domains"]["webhook"]["ok"] is False


def test_individual_settings_endpoints_return_503_on_delta_failure():
    failure = settings.AppSettingsDurabilityError("Delta unavailable")
    with (
        patch.object(settings, "_require_admin"),
        patch.object(settings, "_save_webhook_settings", side_effect=failure),
    ):
        with pytest.raises(HTTPException) as webhook_exc:
            asyncio.run(
                settings.save_webhook_settings(
                    _Request(),
                    settings.WebhookSettings(slack_webhook_url="https://example.invalid"),
                )
            )
    with (
        patch.object(settings, "_require_admin"),
        patch.object(settings, "_save_alert_thresholds", side_effect=failure),
    ):
        with pytest.raises(HTTPException) as thresholds_exc:
            asyncio.run(
                settings.save_alert_thresholds_endpoint(
                    _Request({"daily_budget": 100})
                )
            )
    with (
        patch.object(settings, "_require_admin"),
        patch.object(settings, "_save_pricing_settings", side_effect=failure),
    ):
        with pytest.raises(HTTPException) as pricing_exc:
            asyncio.run(
                settings.set_pricing_mode(
                    _Request(), {"use_account_prices": True}
                )
            )
    assert webhook_exc.value.status_code == 503
    assert thresholds_exc.value.status_code == 503
    assert pricing_exc.value.status_code == 503


def test_unified_schedule_put_merges_only_submitted_keys(tmp_path):
    request = _Request({"schedule": {"hour_utc": 9}})
    with (
        patch.object(settings, "_require_admin"),
        patch.object(settings, "SCHEDULE_SETTINGS_FILE", str(tmp_path / "schedule.json")),
        patch.object(
            settings,
            "load_schedule_settings",
            return_value={
                "enabled": False,
                "frequency": "weekly",
                "hour_utc": 5,
                "lookback_days": 730,
            },
        ),
        patch.object(settings, "_save_schedule_to_table") as save,
    ):
        result = asyncio.run(settings.put_unified_settings(request))
    save.assert_called_once_with(
        {
            "enabled": False,
            "frequency": "weekly",
            "hour_utc": 9,
            "lookback_days": 730,
        }
    )
    assert result["updated_count"] == 1


def test_individual_schedule_update_preserves_unspecified_values(tmp_path):
    with (
        patch.object(settings, "_require_admin"),
        patch.object(settings, "SCHEDULE_SETTINGS_FILE", str(tmp_path / "schedule.json")),
        patch.object(
            settings,
            "load_schedule_settings",
            return_value={
                "enabled": False,
                "frequency": "monthly",
                "hour_utc": 5,
                "lookback_days": 1095,
            },
        ),
        patch.object(settings, "_save_schedule_to_table") as save,
    ):
        result = asyncio.run(
            settings.save_schedule_endpoint(_Request(), {"hour_utc": 11})
        )
    assert result == {
        "enabled": False,
        "frequency": "monthly",
        "hour_utc": 11,
        "lookback_days": 1095,
    }
    save.assert_called_once_with(result)


def test_standalone_schedule_save_propagates_delta_failure(tmp_path):
    with (
        patch.object(settings, "_require_admin"),
        patch.object(settings, "SETTINGS_DIR", str(tmp_path)),
        patch.object(settings, "SCHEDULE_SETTINGS_FILE", str(tmp_path / "schedule.json")),
        patch.object(settings, "load_schedule_settings", return_value={}),
        patch.object(
            settings,
            "_save_schedule_to_table",
            side_effect=RuntimeError("Delta unavailable"),
        ),
    ):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(
                settings.save_schedule_endpoint(_Request(), {"hour_utc": 11})
            )
    assert exc.value.status_code == 503


def test_app_settings_partial_saves_are_serialized_across_workers(tmp_path):
    state = {"company_name": "Before", "theme": "system"}
    state_lock = threading.Lock()

    def load():
        with state_lock:
            snapshot = dict(state)
        time.sleep(0.02)
        return {**settings._APP_SETTINGS_DEFAULTS, **snapshot}

    def write(_sql, params):
        with state_lock:
            state.update(json.loads(params["settings_json"]))
        return 1

    with (
        patch.object(settings, "SETTINGS_DIR", str(tmp_path)),
        patch.object(settings, "APP_SETTINGS_FILE", str(tmp_path / "app.json")),
        patch.object(settings, "get_app_settings", side_effect=load),
        patch.object(settings, "_ensure_app_settings_table"),
        patch.object(settings, "_config_table", return_value="app_settings"),
        patch("server.db.execute_write", side_effect=write),
    ):
        with ThreadPoolExecutor(max_workers=2) as executor:
            list(executor.map(
                lambda partial: settings.save_app_settings(partial),
                ({"company_name": "After"}, {"theme": "dark"}),
            ))

    assert state["company_name"] == "After"
    assert state["theme"] == "dark"


def test_share_last_updated_probes_all_selected_tables_and_returns_max():
    modified = {
        "one": "2026-08-20T10:00:00+00:00",
        "two": "2026-08-28T09:00:00+00:00",
        "three": "2026-08-25T12:00:00+00:00",
    }

    def execute(sql, *_args, **_kwargs):
        name = sql.rsplit("`", 2)[1]
        return [{"lastModified": modified[name]}]

    with patch("server.db.execute_query", side_effect=execute) as query:
        result = settings._share_last_updated("catalog", "schema", list(modified))
    assert result == modified["two"]
    assert query.call_count == 3


def test_shared_source_check_requires_admin():
    denied = HTTPException(status_code=403, detail="Admin required")
    with patch.object(settings, "_require_admin", side_effect=denied):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(settings.check_mv_source_freshness(_Request(), "shared"))
    assert exc.value.status_code == 403


def test_shared_source_add_and_remove_require_admin():
    denied = HTTPException(status_code=403, detail="Admin required")
    with patch.object(settings, "_require_admin", side_effect=denied):
        with pytest.raises(HTTPException) as add_exc:
            asyncio.run(
                settings.add_mv_source(
                    _Request(),
                    {"label": "shared", "catalog": "remote", "schema": "cost"},
                )
            )
        with pytest.raises(HTTPException) as remove_exc:
            asyncio.run(settings.remove_mv_source(_Request(), "shared"))
    assert add_exc.value.status_code == 403
    assert remove_exc.value.status_code == 403


def test_costly_and_mutating_control_routes_require_admin():
    denied = HTTPException(status_code=403, detail="Admin required")
    request = _Request()
    calls = [
        lambda: health.clear_cache(request),
        lambda: settings.trigger_mv_refresh(request, BackgroundTasks()),
        lambda: settings.set_pricing_mode(
            request, {"use_account_prices": True}
        ),
        lambda: settings.save_catalog_settings(
            request, {"catalog": "c", "schema": "s"}
        ),
    ]
    with (
        patch.object(settings, "_require_admin", side_effect=denied),
        patch("server.auth.require_admin", new=AsyncMock(side_effect=denied)),
    ):
        for call in calls:
            with pytest.raises(HTTPException) as exc:
                asyncio.run(call())
            assert exc.value.status_code == 403


def test_mv_source_delta_replacement_is_atomic():
    writes: list[tuple[str, dict | None]] = []
    sources = [
        {
            "label": "west",
            "catalog": "remote",
            "schema": "cost",
            "tables": ["daily_usage_summary"],
        }
    ]
    with (
        patch.object(db, "_mv_sources_table", return_value="mv_sources"),
        patch.object(db, "_ensure_mv_sources_table"),
        patch.object(
            db,
            "execute_write",
            side_effect=lambda sql, params=None: writes.append((sql, params)),
        ),
    ):
        db.write_delta_mv_sources(sources)
    assert len(writes) == 1
    assert "INSERT OVERWRITE" in writes[0][0]
    assert "DELETE FROM" not in writes[0][0]
    assert writes[0][1]["label_0"] == "west"


def test_concurrent_source_adds_do_not_lose_updates():
    from server import materialized_views

    shared_sources: list[dict] = []
    operation_mutex = threading.Lock()

    @contextmanager
    def operation_lock(*_args, **_kwargs):
        with operation_mutex:
            yield SimpleNamespace()

    def get_sources():
        return [dict(source) for source in shared_sources]

    def save_sources(sources):
        shared_sources[:] = [dict(source) for source in sources]

    def add(label):
        return asyncio.run(
            settings.add_mv_source(
                _Request(),
                {"label": label, "catalog": f"remote_{label}", "schema": "cost"},
            )
        )

    with (
        patch.object(settings, "_require_admin"),
        patch("server.db.get_catalog_schema", return_value=("local", "cost")),
        patch("server.db.get_mv_sources", side_effect=get_sources),
        patch("server.db.save_mv_sources", side_effect=save_sources),
            patch("server.db.save_unified_view_tables"),
        patch.object(settings, "_detect_source_cloud", return_value=None),
        patch.object(settings, "append_refresh_history"),
        patch.object(materialized_views, "unified_views_rebuild_lock", operation_lock),
        patch.object(
            materialized_views,
            "_rebuild_unified_views_locked",
            return_value={"ok": True},
        ),
    ):
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(add, ("east", "west")))

    assert all(result["ok"] for result in results)
    assert {source["label"] for source in shared_sources} == {"east", "west"}


def test_shared_source_add_rolls_back_when_view_build_is_partial():
    from server import materialized_views

    @contextmanager
    def operation_lock(*_args, **_kwargs):
        yield SimpleNamespace()

    previous = [{"label": "old", "catalog": "remote", "schema": "cost"}]
    failed = {
        "ok": False,
        "views": {"daily_usage_summary": {"built": False}},
        "routed_tables": [],
    }
    restored = {"ok": True, "views": {}, "routed_tables": ["daily_usage_summary"]}
    with (
        patch.object(settings, "_require_admin"),
        patch("server.db.get_catalog_schema", return_value=("local", "cost")),
        patch("server.db.get_mv_sources", return_value=previous),
        patch("server.db.save_mv_sources") as save_sources,
        patch("server.db.save_unified_view_tables"),
        patch.object(settings, "_detect_source_cloud", return_value=None),
        patch.object(materialized_views, "unified_views_rebuild_lock", operation_lock),
        patch.object(
            materialized_views,
            "_rebuild_unified_views_locked",
            side_effect=[failed, restored],
        ) as rebuild,
    ):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(
                settings.add_mv_source(
                    _Request(),
                    {"label": "new", "catalog": "remote2", "schema": "cost"},
                )
            )

    assert exc.value.status_code == 503
    save_sources.assert_not_called()
    assert rebuild.call_count == 2
    assert rebuild.call_args_list[1].kwargs["sources_override"] == previous


def test_kpis_bundle_filters_lakeflow_successful_runs_by_workspace():
    captured: list[str] = []

    def execute_parallel(queries, *_args, **_kwargs):
        result = {}
        for name, function in queries:
            if name == "lakeflow_kpis":
                result[name] = function()
            else:
                result[name] = []
        return result

    def execute(sql, *_args, **_kwargs):
        captured.append(sql)
        return [{
            "result_state_available": True,
            "successful_runs": 0,
            "total_run_hours": 0,
        }]

    with (
        patch.object(billing, "delta_cache_get", return_value=None),
        patch.object(billing, "delta_cache_put"),
        patch.object(
            billing,
            "capture_cache_generation",
            return_value=db.CacheGeneration("billing:kpis-bundle", 0),
        ),
        patch.object(billing, "_check_mv_available", return_value=False),
        patch.object(billing, "get_catalog_schema", return_value=("catalog", "schema")),
        patch.object(billing, "execute_queries_parallel", side_effect=execute_parallel),
        patch.object(billing, "execute_query", side_effect=execute),
    ):
        result = asyncio.run(
            billing.get_kpis_bundle(
                start_date="2026-08-01",
                end_date="2026-08-28",
                workspace_ids="123",
            )
        )
    lakeflow_sql = next(sql for sql in captured if "job_run_timeline" in sql)
    assert "CAST(workspace_id AS STRING) IN ('123')" in lakeflow_sql
    assert result["kpis"]["successful_runs"] == 0
    assert result["kpis"]["successful_runs_available"] is True


def test_successful_runs_trend_filters_lakeflow_by_workspace():
    with (
        patch.object(billing, "delta_cache_get", return_value=None),
        patch.object(billing, "delta_cache_put") as cache_put,
        patch.object(billing, "_check_mv_available", return_value=True),
        patch.object(
            billing,
            "capture_cache_generation",
            return_value=db.CacheGeneration("trend:sql:platform-kpi", 0),
        ) as capture_generation,
        patch.object(
            billing,
            "execute_query",
            return_value=[{"date": "2026-08-01", "value": 1}],
        ) as execute,
    ):
        asyncio.run(
            billing.get_platform_kpi_trend(
                kpi="successful_runs",
                start_date="2026-08-01",
                end_date="2026-08-28",
                granularity="daily",
                workspace_ids="456",
                tab="sql",
            )
        )
    assert "CAST(workspace_id AS STRING) IN ('456')" in execute.call_args.args[0]
    capture_generation.assert_called_once_with("trend:sql:platform-kpi")
    assert cache_put.call_args.args[1] == "trend:sql:platform-kpi"


def test_local_source_successful_runs_trend_remains_workspace_sensitive():
    source_token = db.set_source_labels(["local"])
    try:
        with (
            patch.object(billing, "get_local_source_label", return_value="local"),
            patch.object(billing, "delta_cache_get", return_value=None),
            patch.object(billing, "delta_cache_put"),
            patch.object(billing, "_check_mv_available", return_value=True),
            patch.object(
                billing,
                "capture_cache_generation",
                return_value=db.CacheGeneration("trend:kpis:platform-kpi", 0),
            ),
            patch.object(
                billing,
                "execute_query",
                return_value=[{"date": "2026-08-01", "value": 1}],
            ) as execute,
        ):
            result = asyncio.run(
                billing.get_platform_kpi_trend(
                    kpi="successful_runs",
                    start_date="2026-08-01",
                    end_date="2026-08-28",
                    granularity="daily",
                    workspace_ids="workspace-west",
                    tab="kpis",
                )
            )
    finally:
        db.reset_source_labels(source_token)

    assert result.get("available", True) is not False
    assert "CAST(workspace_id AS STRING) IN ('workspace-west')" in execute.call_args.args[0]


def test_users_active_user_trend_matches_billing_identity_workspace_scope():
    local_label = db.get_local_source_label()
    source_token = db.set_source_labels([local_label])
    try:
        with (
            patch.object(billing, "get_local_source_label", return_value=local_label),
            patch.object(billing, "delta_cache_get", return_value=None),
            patch.object(billing, "delta_cache_put"),
            patch.object(billing, "_check_mv_available", return_value=False),
            patch.object(billing, "get_catalog_schema", return_value=("catalog", "schema")),
            patch.object(
                billing,
                "capture_cache_generation",
                return_value=db.CacheGeneration("trend:users-groups:billing-kpi", 0),
            ),
            patch.object(
                billing,
                "execute_query",
                return_value=[{"date": "2026-08-01", "value": 2}],
            ) as execute,
        ):
            result = asyncio.run(
                billing.get_kpi_trend(
                    kpi="active_users",
                    start_date="2026-08-01",
                    end_date="2026-08-28",
                    granularity="daily",
                    workspace_ids="456",
                    tab="users-groups",
                )
            )
    finally:
        db.reset_source_labels(source_token)

    assert result["data_points"] == [{"date": "2026-08-01", "value": 2.0}]
    sql = execute.call_args.args[0]
    assert "identity_metadata.run_as" in sql
    assert "CAST(u.workspace_id AS STRING) IN ('456')" in sql


def test_billing_trend_combines_workspace_and_source_scope():
    source_token = db.set_source_labels(["shared-west"])
    try:
        with (
            patch.object(billing, "delta_cache_get", return_value=None),
            patch.object(billing, "delta_cache_put"),
            patch.object(
                billing,
                "capture_cache_generation",
                return_value=db.CacheGeneration("trend:dbu:billing-kpi", 0),
            ),
            patch.object(billing, "_check_mv_available", return_value=True),
            patch.object(billing, "get_catalog_schema", return_value=("catalog", "schema")),
            patch.object(db, "_list_existing_source_row_views", return_value=["daily_usage_summary"]),
            patch.object(db, "get_mv_table_overrides", return_value={}),
            patch.object(
                billing,
                "execute_query",
                return_value=[{"date": "2026-08-01", "value": 1}],
            ) as execute,
        ):
            asyncio.run(
                billing.get_kpi_trend(
                    kpi="total_spend",
                    start_date="2026-08-01",
                    end_date="2026-08-28",
                    granularity="daily",
                    workspace_ids="123",
                    tab="dbu",
                )
            )
        query = execute.call_args.args[0]
        assert "`daily_usage_summary__source_rows`" in query
        assert "CAST(workspace_id AS STRING) IN ('123')" in query
        assert "source_label IN ('shared-west')" in query
    finally:
        db.reset_source_labels(source_token)


def test_shared_only_scope_never_falls_back_to_local_aiml():
    source_token = db.set_source_labels(["shared-west"])
    try:
        with (
            patch.object(aiml, "get_local_source_label", return_value="local"),
            patch.object(aiml, "execute_query") as aiml_query,
        ):
            aiml_result = asyncio.run(
                aiml.get_aiml_summary(
                    start_date="2026-08-01",
                    end_date="2026-08-28",
                )
            )
        assert aiml_result["available"] is False
        aiml_query.assert_not_called()
    finally:
        db.reset_source_labels(source_token)


def test_shared_scope_unsupported_kpi_trend_is_explicitly_unavailable():
    source_token = db.set_source_labels(["shared-west"])
    try:
        with (
            patch.object(billing, "delta_cache_get", return_value=None),
            patch.object(billing, "delta_cache_put"),
            patch.object(billing, "_check_mv_available", return_value=True),
            patch.object(billing, "execute_query") as execute,
        ):
            result = asyncio.run(
                billing.get_kpi_trend(
                    kpi="aiml_endpoints",
                    start_date="2026-08-01",
                    end_date="2026-08-28",
                    granularity="daily",
                    workspace_ids=None,
                    tab="aiml",
                )
            )
        assert result["available"] is False
        assert result["data_points"] == []
        execute.assert_not_called()
    finally:
        db.reset_source_labels(source_token)


def test_shared_only_kpis_bundle_uses_unified_workspace_count_not_local_live_data():
    source_token = db.set_source_labels(["shared-west"])
    seen_names: list[str] = []

    def execute_parallel(queries, *_args, **_kwargs):
        result = {}
        for name, _function in queries:
            seen_names.append(name)
            if name == "active_workspaces":
                result[name] = [{"active_workspaces": 7}]
            elif name == "mv_kpis":
                result[name] = [{"total_queries": 3}]
            else:
                result[name] = []
        return result

    try:
        with (
            patch.object(billing, "delta_cache_get", return_value=None),
            patch.object(billing, "delta_cache_put"),
            patch.object(billing, "_check_mv_available", return_value=True),
            patch.object(billing, "get_catalog_schema", return_value=("c", "s")),
            patch.object(billing, "get_local_source_label", return_value="local"),
                patch.object(
                    db,
                    "get_mv_sources",
                    return_value=[{
                        "label": "shared-west",
                        "tables": [
                            "daily_query_stats",
                            "daily_usage_summary",
                            "daily_workspace_breakdown",
                            "dbsql_cost_per_query",
                        ],
                    }],
                ),
            patch.object(
                billing, "_get_mv_query", side_effect=lambda template, *_: template
            ),
            patch.object(
                billing,
                "execute_queries_parallel",
                side_effect=execute_parallel,
            ),
        ):
            result = asyncio.run(
                billing.get_kpis_bundle(
                    start_date="2026-08-01",
                    end_date="2026-08-28",
                    workspace_ids=None,
                )
            )
        assert result["kpis"]["active_workspaces"] == 7
        assert result["kpis"]["total_queries"] == 3
        assert {
            "billing_kpis",
            "lakeflow_kpis",
            "total_workspaces",
            "avg_daily_models",
        }.isdisjoint(seen_names)
    finally:
        db.reset_source_labels(source_token)


def test_kpis_bundle_reports_unsupported_shared_source_instead_of_false_zero():
    source_token = db.set_source_labels(["west4"])
    try:
        with patch.object(
            db,
            "get_mv_sources",
            return_value=[{
                "label": "west4",
                "tables": ["daily_usage_summary"],
            }],
        ):
            result = asyncio.run(billing.get_kpis_bundle(
                start_date="2026-08-01",
                end_date="2026-08-28",
                workspace_ids=None,
            ))
    finally:
        db.reset_source_labels(source_token)

    assert result["kpis"]["error_code"] == "SOURCE_SCOPE_UNSUPPORTED"
    assert result["kpis"]["total_queries"] == 0


def test_shared_only_platform_live_kpi_trend_is_unavailable():
    source_token = db.set_source_labels(["shared-west"])
    try:
        with (
            patch.object(billing, "delta_cache_get", return_value=None),
            patch.object(billing, "delta_cache_put"),
            patch.object(billing, "_check_mv_available", return_value=True),
            patch.object(billing, "execute_query") as execute,
        ):
            result = asyncio.run(
                billing.get_platform_kpi_trend(
                    kpi="successful_runs",
                    start_date="2026-08-01",
                    end_date="2026-08-28",
                    granularity="daily",
                    workspace_ids=None,
                    tab="kpis",
                )
            )
        assert result["available"] is False
        assert result["data_points"] == []
        execute.assert_not_called()
    finally:
        db.reset_source_labels(source_token)


@pytest.mark.parametrize(
    "kpi",
    ["apps_spend", "apps_dbus", "apps_count", "apps_avg_cost_per_app"],
)
def test_apps_trends_apply_workspace_and_source_scope(kpi):
    captured: list[str] = []
    source_token = db.set_source_labels(["shared-west"])
    try:
        with (
            patch.object(apps, "delta_cache_get", return_value=None),
            patch.object(apps, "delta_cache_put") as cache_put,
            patch.object(
                apps,
                "_app_name_cache",
                {"app-1": {"name": "Current App", "metadata": {}}},
            ),
            patch.object(
                apps,
                "capture_cache_generation",
                return_value=db.CacheGeneration("trend:apps:kpi", 0),
            ),
            patch.object(apps, "_check_mv_available", return_value=True),
            patch.object(apps, "get_catalog_schema", return_value=("catalog", "schema")),
            patch.object(
                apps,
                "source_label_filter_clause",
                return_value=" AND source_label IN ('shared-west')",
            ),
            patch.object(apps, "apply_mv_overrides", side_effect=lambda sql, *_: sql),
            patch.object(
                apps,
                "execute_query",
                side_effect=lambda sql, *_args, **_kwargs: captured.append(sql) or [{
                    "date": "2026-08-01",
                    "value": 1,
                }],
            ),
        ):
            asyncio.run(
                apps.get_apps_kpi_trend(
                    kpi=kpi,
                    start_date="2026-08-01",
                    end_date="2026-08-28",
                    granularity="daily",
                    workspace_ids="123",
                )
            )
        assert "CAST(workspace_id AS STRING) IN ('123')" in captured[0]
        assert "source_label IN ('shared-west')" in captured[0]
        if kpi == "apps_count":
            assert "app_id IN ('app-1')" in captured[0]
            assert "app_id <> 'Unknown'" in captured[0]
        assert cache_put.call_args.args[1] == "trend:apps:kpi"
    finally:
        db.reset_source_labels(source_token)


def test_standalone_platform_kpis_reports_successful_runs_availability():
    with (
        patch.object(billing, "_check_mv_available", return_value=False),
        patch.object(
            billing,
            "execute_query",
            return_value=[{
                "successful_runs": 0,
                "result_state_available": True,
            }],
        ) as execute,
    ):
        result = asyncio.run(
            billing.get_platform_kpis(
                start_date="2026-08-01",
                end_date="2026-08-28",
                fast=True,
            )
        )
    assert "{ws_filter}" not in execute.call_args.args[0]
    assert result["successful_runs"] == 0
    assert result["successful_runs_available"] is True
    assert "result_state_available" in PLATFORM_KPIS_FAST


def test_permissions_update_rejects_removing_every_explicit_admin():
    with (
        patch.object(settings, "_require_admin", return_value="admin@example.com"),
        patch.object(settings, "_save_user_permissions_to_table") as save,
    ):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(
                settings.save_user_permissions(
                    _Request(),
                    settings.UserPermissionsModel(
                        admins=[],
                        consumers=["admin@example.com"],
                    ),
                )
            )

    assert exc.value.status_code == 400
    assert "At least one explicit admin" in str(exc.value.detail)
    save.assert_not_called()
