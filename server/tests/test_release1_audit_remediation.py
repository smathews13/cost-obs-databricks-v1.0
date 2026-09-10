import asyncio
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from server import auth
from server.routers import health, setup


class _Request:
    def __init__(
        self,
        body: dict | None = None,
        headers: dict[str, str] | None = None,
        method: str = "POST",
    ):
        self._body = body or {}
        self.headers = headers or {}
        self.method = method

    async def json(self) -> dict:
        return self._body


@pytest.fixture(autouse=True)
def _reset_auth_state(monkeypatch):
    monkeypatch.delenv("COST_OBS_ENV", raising=False)
    monkeypatch.delenv("COST_OBS_LOCAL_USER", raising=False)
    auth.reset_permission_cache()
    yield
    auth.reset_permission_cache()


def _configured_snapshot(*, age: float = 0.0) -> auth.PermissionSnapshot:
    return auth.PermissionSnapshot(
        state=auth.PermissionState.CONFIGURED,
        admins=("admin@example.com",),
        consumers=("consumer@example.com",),
        loaded_at=time.monotonic() - age,
    )


def test_permission_outage_after_configured_state_fails_closed():
    auth._permission_cache = _configured_snapshot(
        age=auth._PERMISSION_LKG_MAX_AGE_SECONDS + 1
    )
    request = _Request(headers={"X-Forwarded-Email": "admin@example.com"})
    with patch.object(
        auth,
        "_load_permission_snapshot_from_store",
        side_effect=RuntimeError("delta offline"),
    ):
        with pytest.raises(HTTPException) as exc:
            auth.require_admin_sync(request)
    assert exc.value.status_code == 503


def test_bounded_lkg_never_promotes_consumer_during_outage():
    auth._permission_cache = _configured_snapshot(age=90)
    request = _Request(headers={"X-Forwarded-Email": "consumer@example.com"})
    with patch.object(
        auth,
        "_load_permission_snapshot_from_store",
        side_effect=RuntimeError("delta offline"),
    ):
        with pytest.raises(HTTPException) as exc:
            auth.require_admin_sync(request)
    assert exc.value.status_code == 403


def test_trusted_identity_required_for_bootstrap():
    with pytest.raises(HTTPException) as exc:
        asyncio.run(auth.resolve_verified_apps_identity(_Request()))
    assert exc.value.status_code == 401


def test_local_identity_fallback_requires_explicit_mode(monkeypatch):
    monkeypatch.setenv("COST_OBS_LOCAL_USER", "dev@example.com")
    with pytest.raises(HTTPException):
        auth.request_identity(_Request())
    monkeypatch.setenv("COST_OBS_ENV", "local")
    assert auth.request_identity(_Request()) == "dev@example.com"


def test_first_run_claims_verified_owner_before_storage_exists(tmp_path):
    owner_file = tmp_path / "provisional_setup_owner.json"
    request = _Request()
    with (
        patch.object(auth, "_PROVISIONAL_SETUP_OWNER_FILE", str(owner_file)),
        patch.object(
            auth,
            "resolve_verified_apps_identity",
            new=AsyncMock(return_value="installer@example.com"),
        ),
        patch("server.db.get_catalog_schema", return_value=("", "")),
    ):
        email, first_claim = asyncio.run(auth.bootstrap_admin_atomic(request))

    assert email == "installer@example.com"
    assert first_claim is True
    assert owner_file.read_text() == '{"email": "installer@example.com"}'


def test_first_run_rejects_a_different_verified_owner(tmp_path):
    owner_file = tmp_path / "provisional_setup_owner.json"
    request = _Request()
    with (
        patch.object(auth, "_PROVISIONAL_SETUP_OWNER_FILE", str(owner_file)),
        patch.object(
            auth,
            "resolve_verified_apps_identity",
            new=AsyncMock(side_effect=["installer@example.com", "other@example.com"]),
        ),
        patch("server.db.get_catalog_schema", return_value=("", "")),
    ):
        asyncio.run(auth.bootstrap_admin_atomic(request))
        with pytest.raises(HTTPException) as exc:
            asyncio.run(auth.bootstrap_admin_atomic(request))

    assert exc.value.status_code == 409


def test_provisional_owner_can_save_initial_storage(tmp_path):
    owner_file = tmp_path / "provisional_setup_owner.json"
    owner_file.write_text('{"email": "installer@example.com"}')
    request = _Request()
    with (
        patch.object(auth, "_PROVISIONAL_SETUP_OWNER_FILE", str(owner_file)),
        patch.object(
            auth,
            "require_admin",
            new=AsyncMock(
                side_effect=HTTPException(
                    status_code=503,
                    detail="Administrator authorization is temporarily unavailable",
                )
            ),
        ),
        patch.object(
            auth,
            "resolve_verified_apps_identity",
            new=AsyncMock(return_value="installer@example.com"),
        ),
        patch.object(
            auth,
            "bootstrap_admin_atomic_sync",
            side_effect=RuntimeError("schema does not exist yet"),
        ),
    ):
        email = asyncio.run(auth.require_setup_admin(request))

    assert email == "installer@example.com"


def test_concurrent_bootstrap_has_exactly_one_winner():
    rows: list[dict] = []
    lock = threading.Lock()

    def execute_write(_sql, params=None):
        with lock:
            if not any(row["role"] in {"owner", "admin"} for row in rows):
                rows.append({"role": "owner", "email": params["email"]})
        return 1

    def execute_query(*_args, **_kwargs):
        with lock:
            return [dict(row) for row in rows]

    with (
        patch.object(auth, "_ensure_permissions_table", return_value="permissions"),
        patch("server.db.execute_write", side_effect=execute_write),
        patch("server.db.execute_query", side_effect=execute_query),
    ):
        with ThreadPoolExecutor(max_workers=2) as executor:
            outcomes = list(
                executor.map(
                    auth.bootstrap_admin_atomic_sync,
                    ("first@example.com", "second@example.com"),
                )
            )

    assert sum(1 for won, _snapshot in outcomes if won) == 1
    assert len(rows) == 1
    assert rows[0]["role"] == "owner"


def test_existing_consumer_cannot_self_promote_through_bootstrap():
    rows = [
        {"role": "owner", "email": "admin@example.com"},
        {"role": "consumer", "email": "consumer@example.com"},
    ]
    with (
        patch.object(auth, "_ensure_permissions_table", return_value="permissions"),
        patch("server.db.execute_write", return_value=0),
        patch("server.db.execute_query", return_value=rows),
    ):
        won, snapshot = auth.bootstrap_admin_atomic_sync("consumer@example.com")
    assert won is False
    assert snapshot.admins == ("admin@example.com",)


def test_fresh_bootstrap_works_once_and_then_rejects_another_user():
    rows: list[dict] = []

    def execute_write(_sql, params=None):
        if not rows:
            rows.append({"role": "owner", "email": params["email"]})
        return 1

    with (
        patch.object(auth, "_ensure_permissions_table", return_value="permissions"),
        patch("server.db.execute_write", side_effect=execute_write),
        patch(
            "server.db.execute_query",
            side_effect=lambda *_args, **_kwargs: [dict(row) for row in rows],
        ),
    ):
        first, _ = auth.bootstrap_admin_atomic_sync("first@example.com")
        second, snapshot = auth.bootstrap_admin_atomic_sync("second@example.com")
    assert first is True
    assert second is False
    assert snapshot.admins == ("first@example.com",)


def test_generate_token_route_is_not_registered():
    app = FastAPI()
    app.include_router(setup.router, prefix="/api/setup")
    response = TestClient(app).post("/api/setup/generate-token")
    assert response.status_code == 404


def test_every_setup_mutation_rejects_consumer():
    app = FastAPI()
    app.include_router(setup.router, prefix="/api/setup")
    client = TestClient(app)
    auth._permission_cache = _configured_snapshot()
    headers = {"X-Forwarded-Email": "consumer@example.com"}
    mutations = [
        ("POST", "/api/setup/complete"),
        ("POST", "/api/setup/mark-complete"),
        ("POST", "/api/setup/rerun"),
        ("POST", "/api/setup/reset-bootstrap"),
        ("POST", "/api/setup/grant-sp-system-access"),
        ("POST", "/api/setup/create-tables"),
        ("POST", "/api/setup/refresh-tables"),
        ("POST", "/api/setup/aws-cur/create-tables"),
        ("POST", "/api/setup/aws-cur/refresh"),
        ("POST", "/api/setup/ensure-catalog"),
        ("POST", "/api/setup/ensure-schema"),
        ("POST", "/api/setup/grant-catalog-access"),
        ("POST", "/api/setup/save-workspace-filter"),
        ("DELETE", "/api/setup/drop-materialized-views"),
        ("POST", "/api/setup/mv-overrides"),
    ]
    for method, path in mutations:
        response = client.request(method, path, headers=headers, json={})
        assert response.status_code == 403, (method, path, response.text)


def test_mv_override_rejects_sql_injection():
    request = _Request(
        {"overrides": {"daily_usage_summary": "main.cost.table; DROP TABLE x"}}
    )
    with patch.object(setup, "_require_setup_admin", new=AsyncMock()):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(setup.save_mv_overrides(request))
    assert exc.value.status_code == 422


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/api/health/detailed"),
        ("GET", "/api/health/query-diag"),
        ("POST", "/api/billing-diag"),
        ("GET", "/api/debug-env"),
        ("POST", "/api/setup-diag"),
    ],
)
def test_diagnostics_reject_consumer(method, path):
    app = FastAPI()
    app.include_router(health.router, prefix="/api")
    client = TestClient(app)
    auth._permission_cache = _configured_snapshot()
    response = client.request(
        method,
        path,
        headers={"X-Forwarded-Email": "consumer@example.com"},
    )
    assert response.status_code == 403


def test_admin_diagnostic_response_redacts_deployment_details(monkeypatch):
    monkeypatch.setenv("DATABRICKS_HOST", "https://secret.cloud.databricks.com")
    monkeypatch.setenv("DATABRICKS_HTTP_PATH", "/sql/1.0/warehouses/secret")
    monkeypatch.setenv("DATABRICKS_CLIENT_ID", "secret-client-id")
    request = _Request(
        headers={"X-Forwarded-Email": "admin@example.com"},
        method="GET",
    )
    auth._permission_cache = _configured_snapshot()
    with patch("server.db.get_host_url", return_value="https://secret.example.com"):
        response = asyncio.run(health.debug_env(request))
    serialized = str(response).lower()
    assert "secret-client-id" not in serialized
    assert "secret.cloud.databricks.com" not in serialized
    assert "/sql/1.0/warehouses/secret" not in serialized


def test_diagnostic_redaction_removes_raw_errors_and_client_ids(monkeypatch):
    monkeypatch.setenv(
        "DATABRICKS_CLIENT_ID",
        "12345678-1234-1234-1234-123456789abc",
    )
    payload = auth.redact_diagnostic_payload(
        {
            "tests": {
                "warehouse": (
                    "ERROR: request failed for "
                    "12345678-1234-1234-1234-123456789abc at "
                    "https://secret.example.com/sql/path"
                )
            }
        }
    )
    serialized = str(payload).lower()
    assert "request failed" not in serialized
    assert "12345678-1234-1234-1234-123456789abc" not in serialized
    assert "secret.example.com" not in serialized


def test_basic_health_stays_detail_free_and_available():
    response = asyncio.run(health.health_check())
    assert response == {
        "status": "healthy",
        "service": "cost-observability-control",
    }

