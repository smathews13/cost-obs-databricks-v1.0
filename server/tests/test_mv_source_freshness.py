import asyncio
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from server.routers import settings


def test_shared_source_freshness_check_reprobes_and_rebuilds_views():
    sources = [{
        "label": "west",
        "catalog": "shared_catalog",
        "schema": "cost_obs",
        "tables": ["daily_usage_summary"],
    }]

    with (
        patch.object(settings, "_require_admin"),
        patch("server.db.get_mv_sources", return_value=sources),
        patch("server.db.save_mv_sources"),
        patch("server.db.get_catalog_schema", return_value=("local_catalog", "cost_obs")),
        patch("server.materialized_views._MV_TABLES", ["daily_usage_summary", "daily_query_stats"]),
        patch(
            "server.materialized_views._table_columns",
            side_effect=lambda table: (
                ["usage_date", "total_spend"]
                if "daily_usage_summary" in table
                else None
            ),
        ),
        patch("server.materialized_views._rebuild_unified_views_locked", return_value={"ok": True, "views": {}}) as rebuild,
        patch("server.materialized_views.unified_views_rebuild_lock"),
        patch.object(settings, "_visible_shared_tables", return_value={"daily_usage_summary"}),
        patch.object(settings, "_share_last_updated", return_value="2026-08-28T12:00:00Z"),
        patch.object(settings, "_infer_shared_source_workspace_ids", return_value=["west-id"]),
        patch.object(settings, "_invalidate_mv_caches") as invalidate,
    ):
        result = asyncio.run(settings.check_mv_source_freshness(None, "west"))

    assert result["ok"] is True
    assert result["matched"] == 1
    assert result["total"] == 2
    assert result["missing_tables"] == ["daily_query_stats"]
    assert result["share_last_updated"] == "2026-08-28T12:00:00Z"
    assert result["required_grants"] == []
    rebuild.assert_called_once()
    invalidate.assert_called_once()


def test_shared_source_freshness_check_rejects_unknown_label():
    with (
        patch.object(settings, "_require_admin"),
        patch("server.db.get_mv_sources", return_value=[]),
        patch("server.materialized_views.unified_views_rebuild_lock"),
    ):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(settings.check_mv_source_freshness(None, "missing"))

    assert exc.value.status_code == 404


def test_shared_source_freshness_check_requires_workspace_mapping():
    source = {
        "label": "west",
        "catalog": "shared_catalog",
        "schema": "cost_obs",
        "tables": ["daily_usage_summary"],
    }
    with (
        patch.object(settings, "_require_admin"),
        patch("server.db.get_mv_sources", return_value=[source]),
        patch("server.materialized_views.unified_views_rebuild_lock"),
        patch.object(settings, "_infer_shared_source_workspace_ids", return_value=[]),
    ):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(settings.check_mv_source_freshness(None, "west"))

    assert exc.value.status_code == 409
    assert "Apply the grants shown in Settings" in exc.value.detail


def test_shared_source_add_rejects_an_unmapped_source():
    with (
        patch.object(settings, "_require_admin"),
        patch("server.db.get_catalog_schema", return_value=("local_catalog", "cost_obs")),
        patch("server.db.get_mv_sources", return_value=[]),
        patch("server.materialized_views.unified_views_rebuild_lock"),
        patch.object(settings, "_infer_shared_source_workspace_ids", return_value=[]),
    ):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(settings.add_mv_source(None, {
                "label": "west",
                "catalog": "shared_catalog",
                "schema": "cost_obs",
                "tables": ["daily_usage_summary"],
            }))

    assert exc.value.status_code == 400
    assert "Unmapped sources are not queried" in exc.value.detail


def test_shared_source_preview_lists_recipient_objects_before_probing():
    columns = {
        "`local_catalog`.`cost_obs`.`daily_usage_summary`": ["usage_date", "total_spend"],
        "`shared_catalog`.`cost_obs`.`daily_usage_summary`": ["usage_date", "total_spend"],
    }
    with (
        patch("server.db.get_catalog_schema", return_value=("local_catalog", "cost_obs")),
        patch("server.materialized_views._MV_TABLES", ["daily_usage_summary"]),
        patch(
            "server.materialized_views._table_columns",
            side_effect=lambda table: columns.get(table),
        ),
        patch.object(
            settings,
            "_visible_shared_tables",
            return_value={"daily_usage_summary"},
        ) as visible,
        patch.object(
            settings,
            "_shared_source_workspace_candidates",
            return_value=[{
                "workspace_id": "west-id",
                "workspace_name": "west4-serverless",
            }],
        ),
    ):
        result = asyncio.run(
            settings.preview_mv_source("shared_catalog", "cost_obs")
        )

    assert result["matched"] == 1
    assert result["required_grants"] == []
    assert result["workspace_candidates"] == [{
        "workspace_id": "west-id",
        "workspace_name": "west4-serverless",
    }]
    visible.assert_called_once_with("shared_catalog", "cost_obs")


def test_shared_source_preview_distinguishes_unreadable_tables_from_absent_tables():
    with (
        patch("server.db.get_catalog_schema", return_value=("local_catalog", "cost_obs")),
        patch("server.materialized_views._MV_TABLES", ["daily_usage_summary"]),
        patch(
            "server.materialized_views._table_columns",
            side_effect=[["usage_date", "total_spend"], None],
        ),
        patch.object(
            settings,
            "_visible_shared_tables",
            return_value={"daily_usage_summary"},
        ),
        patch.object(settings, "_shared_source_workspace_candidates", return_value=[]),
        patch.dict("os.environ", {"DATABRICKS_CLIENT_ID": "app-client-id"}),
    ):
        result = asyncio.run(
            settings.preview_mv_source("shared_catalog", "cost_obs")
        )

    assert result["tables"] == [{
        "table": "daily_usage_summary",
        "status": "unreadable",
    }]
    assert result["required_grants"] == [
        "GRANT USE CATALOG ON CATALOG `shared_catalog` TO `app-client-id`;",
        "GRANT USE SCHEMA ON SCHEMA `shared_catalog`.`cost_obs` TO `app-client-id`;",
        "GRANT SELECT ON SCHEMA `shared_catalog`.`cost_obs` TO `app-client-id`;",
    ]
