from __future__ import annotations

import ast
import asyncio
import logging
import re
import tomllib
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient

from server import db
from server.app import (
    RequestContextMiddleware,
    RequestLoggingMiddleware,
    _core_refresh_age_hours,
    current_request_id,
)
from server.routers import health, settings

ROOT = Path(__file__).resolve().parents[2]


def _test_app() -> FastAPI:
    app = FastAPI()
    app.add_middleware(RequestLoggingMiddleware)
    app.add_middleware(RequestContextMiddleware)

    @app.get("/ok")
    async def ok():
        logging.getLogger("release4.endpoint").info("endpoint reached")
        return {
            "request_id": current_request_id(),
            "user_token_present": bool(db._user_token.get()),
        }

    @app.get("/failure")
    async def failure():
        raise RuntimeError("upstream failed token=do-not-log https://private.example/path")

    return app


def test_startup_freshness_uses_last_successful_core_refresh():
    now = datetime(2026, 9, 4, 12, 0, tzinfo=timezone.utc)
    refreshed_at = now - timedelta(hours=3)
    with patch(
        "server.db.execute_query",
        return_value=[{"last_refresh_at": refreshed_at}],
    ) as execute:
        age = _core_refresh_age_hours("catalog", "schema", now=now)

    assert age == 3
    sql = execute.call_args.args[0]
    assert "app_mv_refresh_state" in sql
    assert "daily_usage_summary" in sql
    assert "MAX(usage_date)" not in sql


def test_request_middleware_returns_and_propagates_correlation_id(caplog):
    caplog.set_level(logging.INFO)
    response = TestClient(_test_app()).get(
        "/ok",
        headers={"X-Forwarded-Access-Token": "ignored-user-token"},
    )

    request_id = response.headers["X-Request-ID"]
    assert re.fullmatch(r"[0-9a-f]{32}", request_id)
    assert response.json() == {
        "request_id": request_id,
        "user_token_present": False,
    }
    endpoint_record = next(
        record for record in caplog.records if record.name == "release4.endpoint"
    )
    completion_record = next(
        record
        for record in caplog.records
        if record.name == "server.app" and "Request completed" in record.message
    )
    assert endpoint_record.request_id == request_id
    assert completion_record.request_id == request_id
    assert "status=200" in completion_record.message
    assert "duration_ms=" in completion_record.message


def test_request_middleware_logs_redacted_failure_without_changing_error_semantics(
    caplog,
):
    caplog.set_level(logging.INFO)
    response = TestClient(_test_app(), raise_server_exceptions=False).get("/failure")

    assert response.status_code == 500
    failure_record = next(
        record
        for record in caplog.records
        if record.name == "server.app" and "Request failed" in record.message
    )
    assert re.fullmatch(r"[0-9a-f]{32}", failure_record.request_id)
    assert "duration_ms=" in failure_record.message
    assert "exception_type=RuntimeError" in failure_record.message
    assert "exception=upstream failed token=[redacted] [redacted-url]" in (failure_record.message)
    assert "do-not-log" not in caplog.text
    assert "private.example" not in caplog.text


def test_every_handled_response_gets_request_id_and_prewarm_is_gone():
    app = FastAPI()
    app.add_middleware(RequestLoggingMiddleware)
    app.include_router(health.router, prefix="/api")
    client = TestClient(app)

    health_response = client.get("/api/health")
    missing_response = client.post("/api/prewarm")

    assert health_response.status_code == 200
    assert health_response.headers["X-Request-ID"]
    assert missing_response.status_code == 404
    assert missing_response.headers["X-Request-ID"]


def test_request_id_wraps_cors_preflight_without_changing_cors_semantics():
    app = FastAPI()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["https://app.example"],
        allow_credentials=True,
        allow_methods=["GET", "OPTIONS"],
        allow_headers=["Content-Type"],
        expose_headers=["X-Request-ID"],
    )
    app.add_middleware(RequestLoggingMiddleware)
    response = TestClient(app).options(
        "/anything",
        headers={
            "Origin": "https://app.example",
            "Access-Control-Request-Method": "GET",
        },
    )

    assert response.status_code == 200
    assert response.headers["Access-Control-Allow-Origin"] == "https://app.example"
    assert response.headers["X-Request-ID"]


def test_settings_timestamps_are_timezone_aware_utc():
    with (
        patch.object(settings, "_require_admin_async", new=AsyncMock()),
        patch.object(settings, "_load_connections", return_value=[]),
        patch.object(settings, "_upsert_connection_to_table"),
        patch.object(settings, "_save_connections_to_file"),
    ):
        created = asyncio.run(
            settings.create_cloud_connection(
                object(),
                settings.CloudConnectionCreate(name="test", provider="azure"),
            )
        )

    timestamp = datetime.fromisoformat(created["created_at"])
    assert timestamp.utcoffset() is not None
    assert timestamp.utcoffset().total_seconds() == 0
    assert "datetime.utcnow" not in (ROOT / "server/routers/settings.py").read_text()


def test_gcp_connection_api_does_not_store_unused_service_account_json():
    with patch.object(settings, "_require_admin_async", new=AsyncMock()):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(
                settings.create_cloud_connection(
                    object(),
                    settings.CloudConnectionCreate(
                        name="gcp",
                        provider="gcp",
                        service_account_key='{"private_key":"secret"}',
                    ),
                )
            )

    assert exc.value.status_code == 422
    assert "service-account JSON is not stored" in str(exc.value.detail)


def test_runtime_dependencies_match_import_scan_and_keep_transitive_needs():
    project = tomllib.loads((ROOT / "pyproject.toml").read_text())
    lock = tomllib.loads((ROOT / "uv.lock").read_text())
    requirements = (ROOT / "requirements.txt").read_text()
    direct = {
        re.match(r"^[A-Za-z0-9_.-]+", dependency).group(0).lower()
        for dependency in project["project"]["dependencies"]
    }
    imported_roots: set[str] = set()
    for path in (ROOT / "server").rglob("*.py"):
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported_roots.update(alias.name.split(".", 1)[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported_roots.add(node.module.split(".", 1)[0])

    assert {"multipart", "fitz", "pymupdf", "docx"}.isdisjoint(imported_roots)
    assert {
        "python-multipart",
        "pymupdf",
        "python-docx",
        "python-dotenv",
        "protobuf",
        "websockets",
    }.isdisjoint(direct)

    locked_names = {package["name"] for package in lock["package"]}
    assert {"pymupdf", "python-docx", "python-multipart"}.isdisjoint(locked_names)
    for runtime_transitive in ("protobuf", "python-dotenv", "websockets"):
        assert runtime_transitive in locked_names
        assert re.search(
            rf"^{re.escape(runtime_transitive)}==",
            requirements,
            re.MULTILINE,
        )


def test_canonical_docs_use_current_settings_labels_and_valid_local_links():
    docs = [
        ROOT / "README.md",
        ROOT / "cost-obs-architecture.md",
        ROOT / "docs/deployment-guide.md",
        ROOT / "docs/PRE_DEPLOYMENT_CHECKLIST.md",
        ROOT / "docs/post-deploy-smoke-check.md",
        ROOT / "docs/support-runbook.md",
    ]
    combined = "\n".join(path.read_text() for path in docs)
    for stale_label in (
        "Settings → Config",
        "Settings → Debugger",
        "Settings → Access",
    ):
        assert stale_label not in combined
    assert "Settings → Permissions & Access" in combined
    assert "Settings → Data & tables" in combined
    assert "sql user-authorization scope" in combined.lower()
    assert "committed `static/`" in combined
    assert "`sync-mirror.sh`" in combined

    markdown_link = re.compile(r"!?\[[^\]]+\]\(([^)]+)\)")
    for document in docs:
        for target in markdown_link.findall(document.read_text()):
            if target.startswith(("#", "http://", "https://", "mailto:")):
                continue
            relative_target = target.split("#", 1)[0]
            assert (document.parent / relative_target).resolve().exists(), (
                document,
                target,
            )


def test_architecture_inventory_tracks_runtime_aggregate_tables():
    architecture = (ROOT / "cost-obs-architecture.md").read_text()

    assert len(db.MV_UNIFIED_TABLE_NAMES) == 9
    for table_name in db.MV_UNIFIED_TABLE_NAMES:
        assert f"`{table_name}`" in architecture
    assert "`/api/cache/clear`" in architecture
    assert "service principal performs every SQL operation" in architecture
    assert "There is no generic prewarm endpoint" in architecture


def test_architecture_inventory_tracks_consolidated_state_tables():
    architecture = (ROOT / "cost-obs-architecture.md").read_text()

    assert "Durable app state & cache (8)" in architecture
    for retired_table in (
        "app_alert_thresholds",
        "app_webhook_settings",
        "app_pricing_settings",
        "app_schedule_settings",
        "app_workspace_filter",
    ):
        assert retired_table not in architecture
