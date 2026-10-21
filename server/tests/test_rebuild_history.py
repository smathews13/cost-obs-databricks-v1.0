"""Regression coverage for durable rebuild history and storage recovery."""

import asyncio
import json
from contextlib import contextmanager
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from server import app as app_module
from server import db, materialized_views
from server.routers import settings


def _catalog(name: str, catalog_type: str = "MANAGED_CATALOG", **extra):
    return SimpleNamespace(
        name=name,
        catalog_type=catalog_type,
        share_name=extra.get("share_name"),
        provider_name=extra.get("provider_name"),
    )


def _schema(catalog: str, name: str, owner: str, catalog_type: str = "MANAGED_CATALOG"):
    return SimpleNamespace(
        catalog_name=catalog,
        name=name,
        owner=owner,
        catalog_type=catalog_type,
    )


def _table(name: str, table_type: str = "MANAGED"):
    return SimpleNamespace(name=name, table_type=table_type)


def _workspace(catalogs, schemas, tables, identity: str = "sp-123"):
    workspace = SimpleNamespace()
    workspace.current_user = SimpleNamespace(
        me=lambda: SimpleNamespace(id=identity, user_name=identity)
    )
    workspace.catalogs = SimpleNamespace(list=lambda: iter(catalogs))
    workspace.schemas = SimpleNamespace(
        list=lambda catalog_name: iter(schemas.get(catalog_name, []))
    )
    workspace.tables = SimpleNamespace(
        list=lambda catalog_name, schema_name: iter(tables.get((catalog_name, schema_name), []))
    )
    return workspace


@pytest.fixture(autouse=True)
def _reset_discovery_cache():
    db._catalog_discovery_cache.update(
        {"catalog": "", "schema": "", "reason": None, "checked_at": 0.0}
    )
    db._catalog_write_safety_cache.clear()
    yield
    db._catalog_discovery_cache.update(
        {"catalog": "", "schema": "", "reason": None, "checked_at": 0.0}
    )
    db._catalog_write_safety_cache.clear()


def test_storage_discovery_adopts_one_owned_managed_marker_schema():
    workspace = _workspace(
        [_catalog("east1_serverless")],
        {"east1_serverless": [_schema("east1_serverless", "cost_obs_schema", "sp-123")]},
        {
            ("east1_serverless", "cost_obs_schema"): [
                _table("daily_usage_summary"),
                _table("app_user_permissions"),
                _table("app_refresh_log"),
            ]
        },
    )
    with patch.object(db, "get_workspace_client", return_value=workspace):
        assert db._discover_app_storage_target() == (
            "east1_serverless",
            "cost_obs_schema",
            None,
        )


def test_storage_discovery_blocks_when_no_candidate_has_both_marker_classes():
    workspace = _workspace(
        [_catalog("owned")],
        {"owned": [_schema("owned", "schema", "sp-123")]},
        {("owned", "schema"): [_table("daily_usage_summary")]},
    )
    with patch.object(db, "get_workspace_client", return_value=workspace):
        catalog, schema, reason = db._discover_app_storage_target()
    assert (catalog, schema) == ("", "")
    assert "No unambiguous" in reason


def test_storage_discovery_blocks_multiple_owned_candidates():
    workspace = _workspace(
        [_catalog("one"), _catalog("two")],
        {
            "one": [_schema("one", "schema", "sp-123")],
            "two": [_schema("two", "schema", "sp-123")],
        },
        {
            ("one", "schema"): [_table("daily_usage_summary"), _table("app_settings")],
            ("two", "schema"): [_table("daily_usage_summary"), _table("app_refresh_log")],
        },
    )
    with patch.object(db, "get_workspace_client", return_value=workspace):
        catalog, schema, reason = db._discover_app_storage_target()
    assert (catalog, schema) == ("", "")
    assert "Multiple" in reason
    assert "one.schema" in reason and "two.schema" in reason


@pytest.mark.parametrize(
    ("catalog_name", "catalog_type"),
    [
        ("west4_share", "DELTASHARING_CATALOG"),
        ("foreign", "FOREIGN_CATALOG"),
        ("system", "SYSTEM_CATALOG"),
        ("main", "MANAGED_CATALOG"),
    ],
)
def test_storage_discovery_rejects_shared_foreign_system_and_reserved_catalogs(
    catalog_name, catalog_type
):
    workspace = _workspace(
        [_catalog(catalog_name, catalog_type)],
        {catalog_name: [_schema(catalog_name, "cost_obs", "sp-123", catalog_type)]},
        {
            (catalog_name, "cost_obs"): [
                _table("daily_usage_summary"),
                _table("app_refresh_log"),
            ]
        },
    )
    with patch.object(db, "get_workspace_client", return_value=workspace):
        catalog, schema, reason = db._discover_app_storage_target()
    assert (catalog, schema) == ("", "")
    assert reason


def test_storage_discovery_rejects_unowned_or_external_core_table():
    for owner, table_type in (("someone-else", "MANAGED"), ("sp-123", "EXTERNAL")):
        workspace = _workspace(
            [_catalog("owned")],
            {"owned": [_schema("owned", "schema", owner)]},
            {
                ("owned", "schema"): [
                    _table("daily_usage_summary", table_type),
                    _table("app_refresh_log"),
                ]
            },
        )
        with patch.object(db, "get_workspace_client", return_value=workspace):
            assert db._discover_app_storage_target()[:2] == ("", "")


def test_write_validation_rejects_delta_sharing_override():
    workspace = SimpleNamespace(
        catalogs=SimpleNamespace(
            get=lambda _name: _catalog("shared", "DELTASHARING_CATALOG", share_name="costs")
        )
    )
    db._catalog_write_safety_cache.clear()
    with (
        patch.object(db, "get_workspace_client", return_value=workspace),
        pytest.raises(db.StorageConfigurationError, match="read-only"),
    ):
        db.validate_app_storage_target("shared", "cost_obs")


def test_schedule_default_matches_ui_and_readme():
    assert settings._SCHEDULE_DEFAULTS["hour_utc"] == 5


def _utc(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(
        timezone.utc
    )


def test_weekly_schedule_catches_up_on_tuesday_after_monday_slot():
    now = _utc("2026-09-08T11:30:00Z")  # Tuesday

    assert app_module._missed_scheduled_occurrence(
        now,
        "weekly",
        5,
        _utc("2026-08-31T05:00:00Z"),
    ) == _utc("2026-09-07T05:00:00Z")


def test_monthly_schedule_catches_up_after_first_of_month():
    now = _utc("2026-10-14T18:00:00Z")

    assert app_module._missed_scheduled_occurrence(
        now,
        "monthly",
        5,
        _utc("2026-09-01T05:00:00Z"),
    ) == _utc("2026-10-01T05:00:00Z")


@pytest.mark.parametrize("frequency", ["nightly", "weekly", "monthly"])
def test_schedule_does_not_repeat_successful_period(frequency):
    now = _utc("2026-09-08T11:30:00Z")
    latest_slot = app_module._latest_expected_scheduled_occurrence(
        now, frequency, 5
    )

    assert app_module._missed_scheduled_occurrence(
        now, frequency, 5, latest_slot
    ) is None


def test_schedule_boundaries_honor_utc_hour_and_previous_month():
    assert app_module._latest_expected_scheduled_occurrence(
        _utc("2026-09-07T04:59:59Z"), "weekly", 5
    ) == _utc("2026-08-31T05:00:00Z")
    assert app_module._latest_expected_scheduled_occurrence(
        _utc("2026-09-07T05:00:00Z"), "weekly", 5
    ) == _utc("2026-09-07T05:00:00Z")
    assert app_module._latest_expected_scheduled_occurrence(
        _utc("2026-03-01T04:59:59Z"), "monthly", 5
    ) == _utc("2026-02-01T05:00:00Z")
    assert app_module._latest_expected_scheduled_occurrence(
        _utc("2026-03-01T05:00:00Z"), "monthly", 5
    ) == _utc("2026-03-01T05:00:00Z")
    assert app_module._latest_expected_scheduled_occurrence(
        _utc("2026-09-08T02:59:59Z"), "daily", 3
    ) == _utc("2026-09-07T03:00:00Z")


def test_last_successful_rebuild_ignores_newer_failed_attempt():
    refresh_log = {
        "status": "error",
        "last_refresh_utc": "2026-09-08T05:00:00Z",
        "refresh_history": [
            {
                "timestamp": "2026-09-07T05:00:00Z",
                "status": "success",
                "operation": "rebuild",
            },
            {
                "timestamp": "2026-09-08T05:00:00Z",
                "status": "error",
                "operation": "rebuild",
            },
        ],
    }

    assert app_module._last_successful_rebuild_dt(refresh_log) == _utc(
        "2026-09-07T05:00:00Z"
    )


def test_refresh_log_is_in_setup_and_drop_managed_table_sets():
    assert "app_refresh_log" in materialized_views._APP_CONFIG_TABLES


def test_refresh_log_delta_save_is_single_append_statement():
    with (
        patch.object(settings, "_ensure_refresh_log_table"),
        patch.object(settings, "_config_table", return_value="`c`.`s`.`app_refresh_log`"),
        patch("server.db.execute_write") as execute_write,
    ):
        settings.save_refresh_log_to_delta({"status": "success"})

    execute_write.assert_called_once()
    sql = execute_write.call_args.args[0]
    assert "INSERT INTO" in sql
    assert "DELETE" not in sql


def test_refresh_log_round_trip_and_lazy_restore(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SETTINGS_DIR", str(tmp_path))
    saved_rows = []

    def capture_write(_query, params=None):
        saved_rows.append(params["log_json"])
        return 1

    with (
        patch.object(settings, "_ensure_refresh_log_table"),
        patch.object(settings, "_config_table", return_value="`c`.`s`.`app_refresh_log`"),
        patch("server.db.execute_write", side_effect=capture_write),
    ):
        settings.save_refresh_log_to_delta(
            {
                "status": "success",
                "last_refresh_utc": "2026-08-28T05:00:00Z",
                "refresh_history": [{"id": "run-1", "timestamp": "2026-08-28T05:00:00Z"}],
            }
        )

    assert not (tmp_path / "mv_refresh_log.json").exists()
    with (
        patch.object(settings, "_config_table", return_value="`c`.`s`.`app_refresh_log`"),
        patch("server.db.execute_query", return_value=[{"log_json": saved_rows[0]}]) as query,
    ):
        restored = settings.load_refresh_log()

    assert restored["status"] == "success"
    assert restored["refresh_history"][0]["id"] == "run-1"
    assert "ORDER BY updated_at DESC" in query.call_args.args[0]
    assert (tmp_path / "mv_refresh_log.json").exists()


def test_delta_restore_merges_concurrent_snapshots_without_duplicates(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SETTINGS_DIR", str(tmp_path))
    old = {
        "status": "blocked",
        "refresh_history": [
            {"id": "one", "timestamp": "2026-08-28T05:00:00Z", "status": "blocked"}
        ],
    }
    new = {
        "status": "success",
        "refresh_history": [
            {"id": "one", "timestamp": "2026-08-28T05:00:00Z", "status": "blocked"},
            {"id": "two", "timestamp": "2026-08-28T06:00:00Z", "status": "success"},
        ],
    }
    # Query order is newest first, matching ORDER BY updated_at DESC.
    rows = [{"log_json": json.dumps(new)}, {"log_json": json.dumps(old)}]
    with (
        patch.object(settings, "_config_table", return_value="`c`.`s`.`app_refresh_log`"),
        patch("server.db.execute_query", return_value=rows),
    ):
        restored = settings.restore_refresh_log_from_delta()

    assert restored["status"] == "success"
    assert [entry["id"] for entry in restored["refresh_history"]] == ["one", "two"]


def test_append_refresh_history_appends_once_and_invalidates_tables_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SETTINGS_DIR", str(tmp_path))
    monkeypatch.setattr(settings, "_tables_cache", {"stale": True})
    with (
        patch.object(settings, "restore_refresh_log_from_delta", return_value=None),
        patch.object(settings, "save_refresh_log_to_delta") as save,
    ):
        settings.append_refresh_history(
            "skipped",
            "scheduled",
            lookback_days=180,
            block_reason="storage unavailable",
        )

    data = json.loads((tmp_path / "mv_refresh_log.json").read_text())
    assert len(data["refresh_history"]) == 1
    assert data["refresh_history"][0]["status"] == "skipped"
    assert data["refresh_history"][0]["block_reason"] == "storage unavailable"
    save.assert_called_once()
    assert settings._tables_cache is None


def test_history_persists_operation_class_and_filters_startup_probes(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(settings, "SETTINGS_DIR", str(tmp_path))
    entries = [
        {
            "timestamp": "2026-08-28T01:00:00Z",
            "status": "skipped",
            "duration_seconds": 0,
            "lookback_days": 180,
            "trigger": "startup",
            "note": "Managed data is fresh.",
        },
        {
            "timestamp": "2026-08-28T02:00:00Z",
            "status": "success",
            "duration_seconds": 42,
            "lookback_days": 180,
            "trigger": "scheduled",
        },
        {
            "timestamp": "2026-08-28T03:00:00Z",
            "status": "config",
            "duration_seconds": 0,
            "lookback_days": None,
            "trigger": "config",
            "note": "Added shared source 'west'",
        },
        {
            "timestamp": "2026-08-28T04:00:00Z",
            "status": "config",
            "duration_seconds": 0,
            "lookback_days": None,
            "trigger": "config",
            "note": "Removed shared source 'west'",
        },
    ]

    with (
        patch.object(settings, "save_refresh_log_to_delta"),
        patch.object(settings, "restore_refresh_log_from_delta", return_value=None),
    ):
        for entry in entries:
            settings.persist_refresh_log({}, entry)

    persisted = json.loads((tmp_path / "mv_refresh_log.json").read_text())
    assert [entry["operation"] for entry in persisted["refresh_history"]] == [
        "rebuild",
        "rebuild",
        "source_added",
        "source_removed",
    ]

    payload = settings.get_refresh_log_status()
    assert [
        (entry["operation"], entry["status"])
        for entry in payload["refresh_history"]
    ] == [
        ("rebuild", "success"),
        ("source_added", "config"),
    ]


def test_catalog_explorer_links_use_workspace_host_and_exact_fqn():
    with patch("server.db.get_host_url", return_value="https://dbc.example.com/"):
        links = settings._catalog_explorer_table_links(
            "west 4_share", "cost_obs", ["daily/usage"]
        )

    assert links == [
        {
            "fqn": "west 4_share.cost_obs.daily/usage",
            "url": (
                "https://dbc.example.com/explore/data/"
                "west%204_share/cost_obs/daily%2Fusage"
            ),
        }
    ]


def test_detailed_shared_source_payload_exposes_provider_managed_capability():
    sources = [{
        "label": "west",
        "catalog": "west_share",
        "schema": "cost_obs",
        "tables": ["daily_usage_summary"],
        "cloud": "aws",
    }]

    @contextmanager
    def unlocked():
        yield

    with (
        patch("server.db.get_mv_sources", return_value=sources),
        patch("server.db.get_local_source_label", return_value="local"),
        patch("server.db.save_mv_sources"),
        patch("server.db.get_host_url", return_value="https://dbc.example.com"),
        patch(
            "server.materialized_views.unified_views_rebuild_lock",
            return_value=unlocked(),
        ),
        patch.object(
            settings,
            "_share_last_updated",
            return_value="2026-08-28T09:00:00Z",
        ),
        patch.object(
            settings,
            "_visible_shared_tables",
            return_value={"daily_usage_summary"},
        ),
        patch.object(
            settings,
            "_infer_shared_source_workspace_ids",
            return_value=[],
        ),
        patch(
            "server.materialized_views._table_columns",
            return_value=["usage_date"],
        ),
    ):
        payload = asyncio.run(settings.get_mv_sources_endpoint(detail=True))

    assert payload["recipient_refresh"] == {
        "supported": False,
        "mode": "provider_managed",
        "check_action": "metadata_and_local_bindings_only",
    }
    assert payload["sources"][0]["catalog_explorer_tables"] == [{
        "fqn": "west_share.cost_obs.daily_usage_summary",
        "url": (
            "https://dbc.example.com/explore/data/"
            "west_share/cost_obs/daily_usage_summary"
        ),
    }]
    assert payload["sources"][0]["catalog_explorer_schema_url"] == (
        "https://dbc.example.com/explore/data/west_share/cost_obs"
    )


def test_scheduled_refresh_records_truthful_blocked_attempt_once():
    persisted = []
    with (
        patch.object(
            db,
            "get_catalog_schema_status",
            return_value={
                "catalog": "",
                "schema": "",
                "configured": False,
                "block_reason": "multiple app schemas found",
            },
        ),
        patch.object(
            settings,
            "persist_refresh_log",
            side_effect=lambda log, entry: persisted.append((log, entry)),
        ),
    ):
        result = app_module._run_mv_refresh(trigger="scheduled")

    assert result["status"] == "blocked"
    assert len(persisted) == 1
    log, entry = persisted[0]
    assert log["status"] == "blocked"
    assert entry["trigger"] == "scheduled"
    assert entry["status"] == "blocked"
    assert entry["block_reason"] == "multiple app schemas found"


def test_startup_skip_is_recorded_by_only_one_worker():
    claimed = [False]

    def claim_once(*_args, **_kwargs):
        if claimed[0]:
            raise FileExistsError
        claimed[0] = True
        return 99

    with (
        patch.object(app_module.os, "open", side_effect=claim_once),
        patch.object(app_module.os, "close"),
        patch.object(settings, "load_schedule_settings", return_value={"lookback_days": 365}),
        patch.object(settings, "append_refresh_history") as append,
    ):
        app_module._record_startup_skip_once("data is fresh")
        app_module._record_startup_skip_once("data is fresh")

    append.assert_called_once_with(
        "skipped",
        "startup",
        lookback_days=365,
        note="data is fresh",
        block_reason=None,
    )
