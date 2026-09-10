"""Focused coverage for Settings feedback payloads."""

import asyncio
import json
import time
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from server import auth
from server.routers import settings, user


class _JsonRequest:
    headers: dict[str, str] = {}

    def __init__(self, body: dict):
        self._body = body

    async def json(self) -> dict:
        return self._body


def test_feedback_target_is_internal_allowed_setting_with_safe_default():
    assert settings._APP_SETTINGS_DEFAULTS["feedback_slack_url"] is None
    assert "feedback_slack_url" in settings._APP_SETTINGS_ALLOWED
    unsafe = "https://hooks.slack.com/services/" + "synthetic-secret"

    sanitized = settings._sanitize_app_settings({"feedback_slack_url": unsafe})

    assert sanitized["feedback_slack_url"] is None
    assert "synthetic-secret" not in repr(sanitized)


def test_admin_can_save_feedback_target_without_discarding_other_settings(
    tmp_path,
):
    team_id = "T" + ("E" * 8)
    member_id = "U" + ("F" * 8)
    slack_url = f"slack://user?id={member_id}&team={team_id}"
    existing = {
        **settings._APP_SETTINGS_DEFAULTS,
        "company_name": "Example Co",
        "theme": "dark",
        "tab_visibility": {
            **settings._DEFAULT_TAB_VISIBILITY,
            "infra": False,
        },
    }
    writes: list[dict] = []

    def capture_write(sql, params=None):
        if "MERGE INTO" in sql:
            writes.append(json.loads(params["settings_json"]))

    request = _JsonRequest({"feedback": {"slack_url": slack_url}})
    with (
        patch.object(
            settings,
            "_require_admin_async",
            new=AsyncMock(return_value="admin@example.com"),
        ),
        patch.object(settings, "APP_SETTINGS_FILE", str(tmp_path / "app_settings.json")),
        patch.object(settings, "get_app_settings", return_value=existing),
        patch.object(settings, "_ensure_app_settings_table"),
        patch.object(
            settings,
            "_config_table",
            return_value="`catalog`.`schema`.`app_settings`",
        ),
        patch("server.db.execute_write", side_effect=capture_write),
    ):
        result = asyncio.run(settings.put_unified_settings(request))

    assert result == {
        "status": "saved",
        "updated_count": 1,
        "domains": {"app": {"ok": True}},
    }
    assert len(writes) == 1
    persisted = writes[0]
    assert persisted["feedback_slack_url"] == (
        f"slack://user?team={team_id}&id={member_id}"
    )
    assert persisted["company_name"] == "Example Co"
    assert persisted["theme"] == "dark"
    assert persisted["tab_visibility"]["infra"] is False


def test_settings_snapshot_redacts_feedback_target():
    team_id = "T" + ("G" * 8)
    member_id = "W" + ("H" * 8)
    slack_url = f"slack://user?team={team_id}&id={member_id}"
    with (
        patch.object(settings, "get_app_settings", return_value={
            **settings._APP_SETTINGS_DEFAULTS,
            "feedback_slack_url": slack_url,
        }),
        patch.object(settings, "_load_alert_thresholds", return_value={}),
        patch.object(settings, "_load_pricing_settings", return_value={}),
        patch.object(settings, "load_schedule_settings", return_value={}),
        patch.object(settings, "_webhook_masked", return_value={}),
        patch.object(settings, "_capabilities", return_value={}),
    ):
        snapshot = settings._settings_snapshot(_JsonRequest({}))

    assert snapshot["feedback"] == {"slack_configured": True}
    assert team_id not in repr(snapshot)
    assert member_id not in repr(snapshot)
    assert "slack://" not in repr(snapshot)
    assert "feedback_slack_url" not in repr(snapshot)


def test_consumer_cannot_save_feedback_target():
    member_id = "U" + ("J" * 8)
    request = _JsonRequest({
        "feedback": {
            "slack_url": f"https://workspace.slack.com/team/{member_id}",
        }
    })
    denied = HTTPException(status_code=403, detail="Administrator access required")
    with (
        patch.object(
            settings,
            "_require_admin_async",
            new=AsyncMock(side_effect=denied),
        ),
        patch.object(settings, "save_app_settings") as save,
    ):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(settings.put_unified_settings(request))

    assert exc.value.status_code == 403
    save.assert_not_called()


@pytest.mark.parametrize(
    "slack_url",
    [
        "https://hooks.slack.com/services/" + "synthetic-secret",
        "https://workspace.slack.com/team/" + ("U" + ("K" * 8)) + "?token=secret",
        "https://user:secret@workspace.slack.com/team/" + ("U" + ("L" * 8)),
        "slack://user?team=" + ("T" + ("M" * 8)),
        "slack://user?id=" + ("U" + ("N" * 8)),
        "https://workspace.slack.com/team/not-a-member-id",
    ],
)
def test_unified_settings_rejects_unsafe_feedback_urls(slack_url):
    request = _JsonRequest({"feedback": {"slack_url": slack_url}})
    with (
        patch.object(
            settings,
            "_require_admin_async",
            new=AsyncMock(return_value="admin@example.com"),
        ),
        patch.object(settings, "save_app_settings") as save,
    ):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(settings.put_unified_settings(request))

    assert exc.value.status_code == 422
    assert "secret" not in str(exc.value.detail)
    save.assert_not_called()


def test_admin_can_clear_feedback_target_with_null():
    request = _JsonRequest({"feedback": {"slack_url": None}})
    with (
        patch.object(
            settings,
            "_require_admin_async",
            new=AsyncMock(return_value="admin@example.com"),
        ),
        patch.object(settings, "save_app_settings") as save,
    ):
        result = asyncio.run(settings.put_unified_settings(request))

    save.assert_called_once_with({"feedback_slack_url": None})
    assert result["status"] == "saved"
    assert result["updated_count"] == 1


def test_history_is_classified_persisted_and_filtered(tmp_path, monkeypatch):
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
    assert [
        (entry["operation"], entry["status"])
        for entry in settings.get_refresh_log_status()["refresh_history"]
    ] == [
        ("rebuild", "success"),
        ("source_added", "config"),
    ]


def test_catalog_explorer_link_uses_workspace_host_and_exact_fqn():
    with patch("server.db.get_host_url", return_value="https://dbc.example.com/"):
        links = settings._catalog_explorer_table_links(
            "west 4_share", "cost_obs", ["daily/usage"]
        )

    assert links == [{
        "fqn": "west 4_share.cost_obs.daily/usage",
        "url": (
            "https://dbc.example.com/explore/data/"
            "west%204_share/cost_obs/daily%2Fusage"
        ),
    }]


def test_shared_source_payload_marks_provider_managed_refresh():
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
        patch("server.db.get_catalog_schema", return_value=("catalog", "schema")),
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
            "_infer_shared_source_workspace_ids",
            return_value=["workspace-west"],
        ),
        patch(
            "server.materialized_views._rebuild_unified_views_locked",
            return_value={"ok": True},
        ) as rebuild,
        patch(
            "server.materialized_views._table_columns",
            side_effect=lambda table: (
                None if "daily_workspace_breakdown" in table else ["usage_date"]
            ),
        ),
        patch.object(
            settings,
            "_visible_shared_tables",
            return_value={"daily_usage_summary", "daily_workspace_breakdown"},
        ),
        patch.object(settings, "_shared_source_grants", return_value=["GRANT SELECT;"]),
    ):
        payload = asyncio.run(settings.get_mv_sources_endpoint(detail=True))

    assert payload["recipient_refresh"] == {
        "supported": False,
        "mode": "provider_managed",
        "check_action": "metadata_and_local_bindings_only",
    }
    assert payload["local_cloud"] == "aws"
    assert payload["sources"][0]["catalog_explorer_tables"][0]["fqn"] == (
        "west_share.cost_obs.daily_usage_summary"
    )
    assert payload["sources"][0]["catalog_explorer_schema_url"] == (
        "https://dbc.example.com/explore/data/west_share/cost_obs"
    )
    rebuild.assert_called_once()
    assert rebuild.call_args.kwargs["sources_override"][0]["workspace_ids"] == [
        "workspace-west"
    ]
    assert payload["sources"][0]["required_grants"] == ["GRANT SELECT;"]


@pytest.mark.parametrize("catalog", ["west4_share", "east1_share", "central1_share"])
def test_shared_source_cloud_falls_back_to_gcp_region_name(catalog):
    with patch("server.db.get_workspace_client", side_effect=PermissionError("hidden")):
        assert settings._detect_source_cloud(catalog) == "gcp"


def test_shared_source_workspace_scope_uses_all_ids_published_by_share():
    rows = [
        {"workspace_id": "east-id", "workspace_name": "east1-serverless"},
        {"workspace_id": "west-id", "workspace_name": "west4-serverless"},
        {"workspace_id": "central-id", "workspace_name": "central1-serverless"},
    ]
    with patch("server.db.execute_query", return_value=rows):
        result = settings._infer_shared_source_workspace_ids({
            "label": "west4",
            "catalog": "west4_share",
            "schema": "cost_obs_shared",
        })

    assert result == ["east-id", "west-id", "central-id"]


def test_shared_source_workspace_scope_does_not_depend_on_source_label():
    rows = [
        {"workspace_id": "west-a", "workspace_name": "west4-primary"},
        {"workspace_id": "west-b", "workspace_name": "west4-secondary"},
        {"workspace_id": "east-id", "workspace_name": "east1-serverless"},
    ]
    with patch("server.db.execute_query", return_value=rows):
        result = settings._infer_shared_source_workspace_ids({
            "label": "west4",
            "catalog": "west4_share",
            "schema": "cost_obs_shared",
        })

    assert result == ["west-a", "west-b", "east-id"]


def test_shared_source_workspace_scope_accepts_a_single_published_candidate():
    rows = [
        {"workspace_id": "east-id", "workspace_name": "east1-serverless"},
    ]
    with patch("server.db.execute_query", return_value=rows):
        result = settings._infer_shared_source_workspace_ids({
            "label": "west4",
            "catalog": "west4_share",
            "schema": "cost_obs_shared",
        })

    assert result == ["east-id"]


def test_shared_source_workspace_scope_ignores_workspace_name_format():
    rows = [
        {"workspace_id": "north-id", "workspace_name": "northeast1-serverless"},
    ]
    with patch("server.db.execute_query", return_value=rows):
        result = settings._infer_shared_source_workspace_ids({
            "label": "east1",
            "catalog": "east1_share",
            "schema": "cost_obs_shared",
        })

    assert result == ["north-id"]


def test_shared_source_workspace_scope_does_not_truncate_large_shares():
    rows = [
        {"workspace_id": f"workspace-{index}", "workspace_name": f"workspace-{index}"}
        for index in range(250)
    ]
    with patch("server.db.execute_query", return_value=rows) as query:
        result = settings._infer_shared_source_workspace_ids({
            "label": "shared",
            "catalog": "shared_catalog",
            "schema": "cost_obs_shared",
        })

    assert len(result) == 250
    assert "LIMIT" not in query.call_args.args[0]


def test_current_workspace_cloud_detects_all_provider_hosts():
    cases = {
        "https://123.7.gcp.databricks.com": "gcp",
        "https://adb-123.azuredatabricks.net": "azure",
        "https://dbc-example.cloud.databricks.com": "aws",
    }
    for host, expected in cases.items():
        with patch("server.db.get_host_url", return_value=host):
            assert settings._current_workspace_cloud() == expected


@pytest.mark.parametrize(
    ("host", "expected"),
    [
        ("https://dbc-example.cloud.databricks.com", "aws"),
        ("https://adb-123.azuredatabricks.net", "azure"),
        ("https://123.7.gcp.databricks.com", "gcp"),
    ],
)
def test_cloud_provider_endpoint_detects_all_clouds(monkeypatch, host, expected):
    monkeypatch.setenv("DATABRICKS_HOST", host)
    result = asyncio.run(settings.get_cloud_provider())

    assert result["provider"] == expected


def test_role_payloads_match_admin_route_policy():
    consumer_request = SimpleNamespace(
        headers={"X-Forwarded-Email": "viewer@example.com"}
    )
    with patch.object(user, "_get_user_role", return_value="consumer"):
        current_user = asyncio.run(user.get_current_user(consumer_request))
    assert current_user["capabilities"]["can_manage_settings"] is False
    assert current_user["capabilities"]["can_manage_data"] is False

    admin_request = SimpleNamespace(
        headers={"X-Forwarded-Email": "admin@example.com"}
    )
    with (
        patch.object(
            settings,
            "_load_user_permissions",
            return_value={
                "admins": ["admin@example.com"],
                "consumers": ["viewer@example.com"],
            },
        ),
        patch(
            "server.routers.health.deployment_metadata",
            new=AsyncMock(return_value={
                "deployer": "admin@example.com",
                "source": "databricks_apps_api",
                "available": True,
            }),
        ),
        patch("server.db.get_catalog_schema", return_value=("main", "cost_obs")),
    ):
        permissions = asyncio.run(settings.get_user_permissions(admin_request))
    assert permissions["current_role"] == "admin"
    assert permissions["owner"] == {
        "email": "admin@example.com",
        "source": "databricks_apps_api",
        "verified": True,
        "deployment_creator": "admin@example.com",
    }
    assert permissions["role_capabilities"]["admin"]["can_manage_users"] is True
    assert permissions["role_capabilities"]["consumer"]["can_manage_users"] is False


def test_empty_admin_list_is_bootstrap_only_not_implicit_admin():
    request = SimpleNamespace(headers={"X-Forwarded-Email": "new-user@example.com"})
    auth._permission_cache = auth.PermissionSnapshot(
        state=auth.PermissionState.BOOTSTRAPPABLE,
        admins=(),
        consumers=(),
        loaded_at=__import__("time").monotonic(),
    )
    with pytest.raises(HTTPException) as exc:
        settings._require_admin(request)
    assert exc.value.status_code == 403
    assert settings._is_admin(request) is False


def test_resource_inventory_is_bounded_and_redacts_connection_credentials(monkeypatch):
    from server import db

    connection_row = {
        "id": "connection-1",
        "name": "AWS CUR",
        "provider": "aws",
        "secret_access_key": "do-not-return",
        "access_key_id": "also-do-not-return",
    }
    queries = []
    monkeypatch.setattr(settings, "_config_table", lambda name: f"`catalog`.`schema`.`{name}`")
    monkeypatch.setattr(
        db,
        "execute_query",
        lambda query, *_args, **_kwargs: queries.append(query) or [connection_row],
    )
    monkeypatch.setattr(settings, "_resource_shared_source_metadata", lambda: [{
        "label": "west",
        "catalog": "west_share",
        "schema": "cost_obs",
        "tables": ["daily_usage_summary"],
    }])
    monkeypatch.setattr(settings, "_resource_unified_views", lambda: ["daily_usage_summary"])
    monkeypatch.setattr(
        "server.workspace_filter.get_configured_workspace_ids",
        lambda: ["100", "200"],
    )
    settings._tables_cache = None

    result = settings._resource_inventory_snapshot()

    assert result["inventory"]["aggregates"]["count"] == len(
        db.MV_UNIFIED_TABLE_NAMES
    )
    assert result["inventory"]["cache"]["process_max_entries"] == db._CACHE_MAX_SIZE
    assert result["workspace_filter"] == {
        "mode": "restricted",
        "count": 2,
    }
    assert result["cloud_cost_connections"] == [{
        "id": "connection-1",
        "name": "AWS CUR",
        "provider": "aws",
    }]
    assert "do-not-return" not in repr(result)
    assert "access_key_id" not in repr(result)
    assert "LIMIT 100" in queries[0]
    assert "secret" not in queries[0].lower()


def test_resource_source_and_view_inventory_queries_are_bounded(monkeypatch):
    from server import db

    queries = []
    monkeypatch.setattr(db, "get_catalog_schema", lambda: ("catalog", "schema"))
    monkeypatch.setattr(
        db,
        "execute_query",
        lambda query, *_args, **_kwargs: queries.append(query) or [],
    )

    assert settings._resource_shared_source_metadata() == []
    assert settings._resource_unified_views() == []
    assert len(queries) == 2
    assert all("LIMIT 100" in query for query in queries)


def test_resources_returns_other_sections_when_apps_api_times_out(monkeypatch):
    async def slow_links():
        # Deliberately block before any await to prove the endpoint isolates SDK
        # handlers whose async wrappers still contain synchronous work.
        time.sleep(0.08)
        return {"app_name": "too-late"}

    monkeypatch.setattr(settings, "_RESOURCES_SUBSECTION_TIMEOUT_SECONDS", 0.01)
    monkeypatch.setattr(settings, "_RESOURCES_ENDPOINT_DEADLINE_SECONDS", 1.0)
    monkeypatch.setenv("DATABRICKS_APP_NAME", "cost-obs")
    monkeypatch.setattr(settings, "get_app_config", AsyncMock(return_value={
        "storage_location": {"catalog": "catalog", "schema": "schema"},
        "warehouse": None,
        "version": {},
    }))
    monkeypatch.setattr(settings, "get_auth_status_endpoint", AsyncMock(return_value={}))
    monkeypatch.setattr(settings, "get_app_links", slow_links)
    monkeypatch.setattr(settings, "_resource_shared_source_metadata", lambda: [])
    monkeypatch.setattr(settings, "_resource_connection_metadata", lambda: [])
    monkeypatch.setattr(settings, "_resource_unified_views", lambda: [])
    monkeypatch.setattr(
        "server.workspace_filter.get_configured_workspace_ids",
        lambda: [],
    )
    monkeypatch.setattr(settings, "_resource_refresh_snapshot", lambda: {
        "schedule": {
            "enabled": True,
            "frequency": "nightly",
            "hour_utc": 5,
            "lookback_days": 180,
        },
        "status": {"status": "success"},
    })
    with patch(
        "server.routers.health.deployment_metadata",
        new=AsyncMock(return_value={
            "deployed_at": "2026-08-31T17:00:00Z",
            "deployer": "owner@example.com",
            "commit_sha": "abc123",
            "available": True,
            "source": "databricks_apps_api",
        }),
    ):
        result = asyncio.run(settings.get_resources())

    assert settings._RESOURCES_SUBSECTION_TIMEOUT_SECONDS <= 3
    assert settings._RESOURCES_ENDPOINT_DEADLINE_SECONDS <= 10
    assert result["subsections"]["app_links"] == {
        "available": False,
        "reason": "temporarily_unavailable",
    }
    assert result["subsections"]["config"] == {"available": True}
    assert result["storage"]["catalog"] == "catalog"
    assert result["app"]["name"] == "cost-obs"


def test_resources_keeps_fast_inventory_when_one_sql_subsection_times_out(
    monkeypatch,
):
    def slow_sources():
        time.sleep(0.2)
        return [{"label": "too-late"}]

    monkeypatch.setattr(settings, "_RESOURCES_SUBSECTION_TIMEOUT_SECONDS", 0.05)
    monkeypatch.setattr(settings, "_RESOURCES_ENDPOINT_DEADLINE_SECONDS", 0.15)
    monkeypatch.setattr(settings, "get_app_config", AsyncMock(return_value={
        "storage_location": {},
        "warehouse": None,
        "version": {},
    }))
    monkeypatch.setattr(settings, "get_auth_status_endpoint", AsyncMock(return_value={}))
    monkeypatch.setattr(settings, "get_app_links", AsyncMock(return_value={}))
    monkeypatch.setattr(settings, "_resource_shared_source_metadata", slow_sources)
    monkeypatch.setattr(
        settings,
        "_resource_connection_metadata",
        lambda: [{"name": "AWS CUR", "provider": "aws"}],
    )
    monkeypatch.setattr(settings, "_resource_unified_views", lambda: ["daily_usage_summary"])
    monkeypatch.setattr(
        "server.workspace_filter.get_configured_workspace_ids",
        lambda: ["100"],
    )
    monkeypatch.setattr(settings, "_resource_refresh_snapshot", lambda: {
        "schedule": {
            "enabled": False,
            "frequency": "nightly",
            "hour_utc": 5,
            "lookback_days": 180,
        },
        "status": None,
    })
    with patch(
        "server.routers.health.deployment_metadata",
        new=AsyncMock(return_value={
            "deployed_at": "2026-08-31T17:00:00Z",
            "deployer": None,
            "commit_sha": None,
            "available": True,
            "source": "process_start_approximate_restart",
        }),
    ):
        result = asyncio.run(settings.get_resources())

    assert result["subsections"]["shared_data_sources"] == {
        "available": False,
        "reason": "temporarily_unavailable",
    }
    assert result["subsections"]["cloud_cost_connections"] == {"available": True}
    assert result["shared_data_sources"] == []
    assert result["cloud_cost_connections"] == [{"name": "AWS CUR", "provider": "aws"}]
    assert result["inventory"]["unified_views"]["names"] == ["daily_usage_summary"]
    assert result["workspace_filter"] == {"mode": "restricted", "count": 1}


def test_auth_status_exposes_safe_authoritative_identity_link(monkeypatch):
    me = SimpleNamespace(
        id="sp-object-123",
        user_name="client-123",
        display_name="app-cost-obs",
    )
    monkeypatch.setenv("DATABRICKS_HOST", "https://dbc.example.com")
    monkeypatch.setenv("DATABRICKS_CLIENT_ID", "client-123")
    with (
        patch("server.db.get_auth_status", return_value={}),
        patch(
            "server.db.get_workspace_client",
            return_value=SimpleNamespace(
                current_user=SimpleNamespace(me=lambda: me)
            ),
        ),
        patch("server.db.get_catalog_schema", return_value=("main", "cost_obs")),
    ):
        result = asyncio.run(settings.get_auth_status_endpoint())

    assert result["sp_object_id"] == "sp-object-123"
    assert result["sp_client_id"] == "client-123"
    assert result["effective_oauth_scopes"] == ["all-apis"]
    assert result["sp_identity_url"] == (
        "https://dbc.example.com/api/2.0/preview/scim/v2/"
        "ServicePrincipals/sp-object-123"
    )
    assert "secret" not in result


def test_resource_links_reject_credentials_and_strip_token_queries():
    assert settings._safe_resource_link(
        "https://user:secret@github.com/example/repo"
    ) == ""
    assert settings._safe_resource_link(
        "https://github.com/example/repo?access_token=secret#fragment"
    ) == "https://github.com/example/repo"
    assert settings._safe_resource_link(
        "https://dbc.example.com/apps-v2/app/cost-obs/overview?o=12345"
    ).endswith("?o=12345")


def test_gcp_app_links_use_app_level_git_repository_without_active_deployment(
    monkeypatch,
):
    app_body = {
        "name": "cost-obs-gcp",
        "url": "https://cost-obs-gcp-123456789.gcp.databricksapps.com",
        "update_time": "2026-08-31T16:42:03Z",
        "updater": "deployer@example.com",
        "git_repository": {
            "url": "https://github.com/example/cost-obs",
            "provider": "gitHub",
        },
    }
    workspace = SimpleNamespace(
        api_client=SimpleNamespace(
            do=lambda method, path, **_kwargs: app_body
            if (method, path) == ("GET", "/api/2.0/apps/cost-obs-gcp")
            else {}
        )
    )
    monkeypatch.setenv(
        "DATABRICKS_HOST",
        "https://1234567890123456.7.gcp.databricks.com",
    )
    monkeypatch.setenv("DATABRICKS_APP_NAME", "cost-obs-gcp")
    with patch("server.db.get_workspace_client", return_value=workspace):
        result = asyncio.run(settings.get_app_links())

    assert result["source_code_url"] == "https://github.com/example/cost-obs"
    assert result["app_page_url"].endswith(
        "/apps-v2/app/cost-obs-gcp/overview?o=123456789"
    )


def test_owner_cannot_be_demoted_when_other_admins_remain():
    request = SimpleNamespace(headers={"X-Forwarded-Email": "backup@example.com"})
    current = {
        "admins": ["owner@example.com", "backup@example.com"],
        "consumers": [],
        "owner": "owner@example.com",
    }
    with (
        patch.object(
            settings,
            "_require_admin_async",
            new=AsyncMock(return_value="backup@example.com"),
        ),
        patch.object(settings, "_load_user_permissions", return_value=current),
        patch(
            "server.routers.health.deployment_metadata",
            new=AsyncMock(return_value={
                "deployer": "owner@example.com",
                "source": "databricks_apps_api",
                "available": True,
            }),
        ),
    ):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(settings.save_user_permissions(
                request,
                settings.UserPermissionsModel(
                    admins=["backup@example.com"],
                    consumers=["owner@example.com"],
                ),
            ))

    assert exc.value.status_code == 400
    assert "Owner" in str(exc.value.detail)


def test_permission_owner_has_stable_store_fallback():
    with patch(
        "server.routers.health.deployment_metadata",
        new=AsyncMock(return_value={
            "deployer": None,
            "source": "unavailable",
            "available": False,
        }),
    ):
        owner = asyncio.run(settings._permission_owner({
            "admins": ["stored-owner@example.com", "backup@example.com"],
            "consumers": [],
            "owner": "stored-owner@example.com",
        }))

    assert owner == {
        "email": "stored-owner@example.com",
        "source": "permission_store",
        "verified": False,
        "deployment_creator": None,
    }
