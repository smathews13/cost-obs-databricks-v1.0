"""Centralized, fail-closed application authorization."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import threading
import time
from dataclasses import dataclass
from enum import Enum
from typing import Any

from fastapi import HTTPException, Request

logger = logging.getLogger(__name__)

_PERMISSION_CACHE_TTL_SECONDS = 60.0
_PERMISSION_LKG_MAX_AGE_SECONDS = 300.0
_PERMISSION_READ_TIMEOUT_SECONDS = 8.0
_IDENTITY_VERIFY_TIMEOUT_SECONDS = 8.0
_PROVISIONAL_SETUP_OWNER_FILE = os.path.join(
    os.path.dirname(__file__), "..", ".settings", "provisional_setup_owner.json"
)


class PermissionState(str, Enum):
    """Durable permission-store lifecycle states."""

    UNINITIALIZED = "uninitialized"
    BOOTSTRAPPABLE = "bootstrappable"
    CONFIGURED = "configured"


@dataclass(frozen=True)
class PermissionSnapshot:
    state: PermissionState
    admins: tuple[str, ...]
    consumers: tuple[str, ...]
    loaded_at: float
    owner: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "admins": list(self.admins),
            "consumers": list(self.consumers),
            "owner": self.owner,
        }


class PermissionStoreUnavailable(RuntimeError):
    """The durable permission state could not be proven."""


_permission_cache_lock = threading.RLock()
_permission_cache = PermissionSnapshot(
    state=PermissionState.UNINITIALIZED,
    admins=(),
    consumers=(),
    loaded_at=0.0,
)


def is_explicit_local_mode() -> bool:
    """Return whether insecure local identity/file fallbacks were explicitly enabled."""

    return os.getenv("COST_OBS_ENV", "").strip().lower() == "local"


def _request_header(request: Request, name: str) -> str:
    return (request.headers.get(name) or "").strip()


def request_identity(request: Request) -> str:
    """Resolve request identity without trusting production environment fallbacks."""

    forwarded = _request_header(request, "X-Forwarded-Email")
    if forwarded:
        return forwarded.lower()
    if is_explicit_local_mode():
        local_user = os.getenv("COST_OBS_LOCAL_USER", "").strip()
        if local_user:
            return local_user.lower()
    raise HTTPException(status_code=401, detail="Trusted Databricks Apps identity required")


def _permissions_table() -> str:
    from server.db import (
        StorageConfigurationError,
        get_catalog_schema,
        validate_app_storage_target,
    )

    catalog, schema = get_catalog_schema()
    try:
        validate_app_storage_target(catalog, schema)
    except StorageConfigurationError as exc:
        raise PermissionStoreUnavailable(
            "Durable permission storage is not configured"
        ) from exc
    return f"`{catalog}`.`{schema}`.`app_user_permissions`"


def _ensure_permissions_table() -> str:
    from server.db import execute_write

    table = _permissions_table()
    execute_write(
        f"CREATE TABLE IF NOT EXISTS {table} "
        "(role STRING NOT NULL, email STRING NOT NULL, updated_at TIMESTAMP) USING DELTA",
        None,
    )
    return table


def _snapshot_from_rows(rows: list[dict[str, Any]]) -> PermissionSnapshot:
    owner_emails = [
        str(row.get("email") or "").strip().lower()
        for row in rows
        if row.get("role") == "owner" and str(row.get("email") or "").strip()
    ]
    admin_emails = [
        str(row.get("email") or "").strip().lower()
        for row in rows
        if row.get("role") == "admin" and str(row.get("email") or "").strip()
    ]
    consumer_emails = [
        str(row.get("email") or "").strip().lower()
        for row in rows
        if row.get("role") == "consumer" and str(row.get("email") or "").strip()
    ]
    admins = tuple(dict.fromkeys([*owner_emails, *admin_emails]))
    consumers = tuple(email for email in dict.fromkeys(consumer_emails) if email not in admins)
    state = PermissionState.CONFIGURED if admins else PermissionState.BOOTSTRAPPABLE
    return PermissionSnapshot(
        state=state,
        admins=admins,
        consumers=consumers,
        loaded_at=time.monotonic(),
        owner=owner_emails[0] if owner_emails else None,
    )


def _load_permission_snapshot_from_store() -> PermissionSnapshot:
    from server.db import execute_query

    table = _ensure_permissions_table()
    rows = execute_query(
        f"SELECT role, email FROM {table}",
        None,
        no_cache=True,
    )
    return _snapshot_from_rows(rows or [])


def _local_permission_snapshot() -> PermissionSnapshot | None:
    if not is_explicit_local_mode():
        return None
    local_user = os.getenv("COST_OBS_LOCAL_USER", "").strip().lower()
    if not local_user:
        return None
    return PermissionSnapshot(
        state=PermissionState.CONFIGURED,
        admins=(local_user,),
        consumers=(),
        loaded_at=time.monotonic(),
    )


def reset_permission_cache() -> None:
    """Reset process-local permission state. Intended for tests and explicit writes."""

    global _permission_cache
    with _permission_cache_lock:
        _permission_cache = PermissionSnapshot(
            state=PermissionState.UNINITIALIZED,
            admins=(),
            consumers=(),
            loaded_at=0.0,
        )


def _read_provisional_setup_owner() -> str | None:
    """Read the verified owner claim used before app storage exists."""
    try:
        with open(_PROVISIONAL_SETUP_OWNER_FILE) as handle:
            email = str(json.load(handle).get("email") or "").strip().lower()
            return email or None
    except (FileNotFoundError, json.JSONDecodeError, OSError, AttributeError):
        return None


def _claim_provisional_setup_owner(email: str) -> bool:
    """Atomically claim setup ownership while catalog/schema are unconfigured."""
    normalized = email.strip().lower()
    os.makedirs(os.path.dirname(_PROVISIONAL_SETUP_OWNER_FILE), exist_ok=True)
    payload = json.dumps({"email": normalized}).encode()
    try:
        descriptor = os.open(
            _PROVISIONAL_SETUP_OWNER_FILE,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
    except FileExistsError:
        return _read_provisional_setup_owner() == normalized
    try:
        os.write(descriptor, payload)
    finally:
        os.close(descriptor)
    return True


def _clear_provisional_setup_owner(email: str) -> None:
    """Remove the temporary claim after the same user becomes durable owner."""
    if _read_provisional_setup_owner() != email.strip().lower():
        return
    try:
        os.remove(_PROVISIONAL_SETUP_OWNER_FILE)
    except FileNotFoundError:
        pass


def _set_permission_cache(snapshot: PermissionSnapshot) -> PermissionSnapshot:
    global _permission_cache
    with _permission_cache_lock:
        _permission_cache = snapshot
    return snapshot


def get_permission_snapshot_sync(*, force_refresh: bool = False) -> PermissionSnapshot:
    """Load permissions, using configured last-known-good data for a bounded period."""

    now = time.monotonic()
    with _permission_cache_lock:
        cached = _permission_cache
    if (
        not force_refresh
        and cached.state is not PermissionState.UNINITIALIZED
        and now - cached.loaded_at < _PERMISSION_CACHE_TTL_SECONDS
    ):
        return cached

    try:
        return _set_permission_cache(_load_permission_snapshot_from_store())
    except Exception as exc:
        local = _local_permission_snapshot()
        if local is not None:
            logger.warning("Using explicit local-mode administrator identity")
            return _set_permission_cache(local)
        with _permission_cache_lock:
            cached = _permission_cache
        if (
            cached.state is PermissionState.CONFIGURED
            and now - cached.loaded_at <= _PERMISSION_LKG_MAX_AGE_SECONDS
        ):
            logger.warning(
                "Permission store unavailable; using bounded configured last-known-good state"
            )
            return cached
        logger.error("Durable permission state unavailable: %s", exc)
        raise PermissionStoreUnavailable(
            "Durable permission state is temporarily unavailable"
        ) from exc


async def get_permission_snapshot(*, force_refresh: bool = False) -> PermissionSnapshot:
    """Read permissions off the event loop with a hard request-boundary timeout."""

    try:
        return await asyncio.wait_for(
            asyncio.to_thread(
                get_permission_snapshot_sync,
                force_refresh=force_refresh,
            ),
            timeout=_PERMISSION_READ_TIMEOUT_SECONDS,
        )
    except TimeoutError as exc:
        raise PermissionStoreUnavailable(
            "Durable permission state timed out"
        ) from exc


def require_admin_sync(request: Request) -> str:
    """Synchronous fail-closed check; async routes must call it through ``to_thread``."""

    email = request_identity(request)
    try:
        snapshot = get_permission_snapshot_sync()
    except PermissionStoreUnavailable as exc:
        raise HTTPException(
            status_code=503,
            detail="Administrator authorization is temporarily unavailable",
        ) from exc
    if snapshot.state is not PermissionState.CONFIGURED:
        raise HTTPException(
            status_code=403,
            detail="An administrator must be bootstrapped before this action",
        )
    if email not in snapshot.admins:
        raise HTTPException(status_code=403, detail="Admin role required")
    return email


async def require_admin(request: Request) -> str:
    """Fail-closed async route dependency that never runs warehouse SQL on the event loop."""

    try:
        return await asyncio.wait_for(
            asyncio.to_thread(require_admin_sync, request),
            timeout=_PERMISSION_READ_TIMEOUT_SECONDS,
        )
    except TimeoutError as exc:
        raise HTTPException(
            status_code=503,
            detail="Administrator authorization timed out",
        ) from exc


async def require_setup_admin(request: Request) -> str:
    """Authorize setup, including the verified owner before storage is created."""
    try:
        return await require_admin(request)
    except HTTPException as exc:
        if exc.status_code == 403 and exc.detail != (
            "An administrator must be bootstrapped before this action"
        ):
            raise
        if exc.status_code not in (403, 503):
            raise

    email = await resolve_verified_apps_identity(request)
    if _read_provisional_setup_owner() != email:
        raise HTTPException(status_code=403, detail="The verified setup owner must complete initial setup")

    try:
        won, _durable = await asyncio.wait_for(
            asyncio.to_thread(bootstrap_admin_atomic_sync, email),
            timeout=_PERMISSION_READ_TIMEOUT_SECONDS,
        )
    except Exception:
        # The catalog or schema may be selected but not created yet. The atomic
        # provisional claim remains authoritative until a later setup step can
        # create and populate the durable permissions table.
        return email
    if not won:
        raise HTTPException(
            status_code=409,
            detail="An administrator has already been configured",
        )
    _clear_provisional_setup_owner(email)
    return email


async def get_user_role(request: Request) -> str:
    """Return a fail-closed display role for an authenticated app user."""

    email = request_identity(request)
    try:
        snapshot = await get_permission_snapshot()
    except PermissionStoreUnavailable:
        return "consumer"
    if snapshot.state is PermissionState.CONFIGURED and email in snapshot.admins:
        return "admin"
    return "consumer"


async def resolve_verified_apps_identity(request: Request) -> str:
    """Verify the caller with their forwarded Databricks Apps OAuth token."""

    forwarded_email = _request_header(request, "X-Forwarded-Email").lower()
    token = _request_header(request, "x-forwarded-access-token")
    if is_explicit_local_mode() and not token:
        return request_identity(request)
    if not token:
        raise HTTPException(
            status_code=401,
            detail="A trusted Databricks Apps OAuth identity is required",
        )

    def _verify() -> str:
        from databricks.sdk import WorkspaceClient

        host = os.getenv("DATABRICKS_HOST", "").strip()
        if not host:
            raise RuntimeError("Databricks workspace host is unavailable")
        client = WorkspaceClient(host=host, token=token, auth_type="pat")
        me = client.current_user.me()
        return str(me.user_name or "").strip().lower()

    try:
        verified_email = await asyncio.wait_for(
            asyncio.to_thread(_verify),
            timeout=_IDENTITY_VERIFY_TIMEOUT_SECONDS,
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("Databricks Apps caller identity verification failed: %s", exc)
        raise HTTPException(
            status_code=401,
            detail="Databricks Apps caller identity could not be verified",
        ) from exc
    if not verified_email or (forwarded_email and forwarded_email != verified_email):
        raise HTTPException(
            status_code=401,
            detail="Forwarded identity does not match the OAuth caller",
        )
    return verified_email


def bootstrap_admin_atomic_sync(email: str) -> tuple[bool, PermissionSnapshot]:
    """Atomically claim the durable singleton owner row for the first caller."""

    from server.db import execute_query, execute_write

    normalized = email.strip().lower()
    table = _ensure_permissions_table()
    # Delta's optimistic concurrency control serializes concurrent writers to this
    # table. The merge is unmatched only while no owner/admin is present, making
    # the singleton ``owner`` insert a one-statement compare-and-set.
    try:
        execute_write(
            f"MERGE INTO {table} AS target "
            "USING (SELECT :email AS email) AS source "
            "ON target.role IN ('owner', 'admin') "
            "WHEN NOT MATCHED THEN INSERT (role, email, updated_at) "
            "VALUES ('owner', source.email, current_timestamp())",
            {"email": normalized},
        )
    except Exception:
        # Concurrent Delta writers may surface an optimistic-transaction conflict.
        # Resolve it by reading the committed winner; only re-raise if no durable
        # administrator exists after the failed compare-and-set.
        rows_after_conflict = execute_query(
            f"SELECT role, email FROM {table}",
            None,
            no_cache=True,
        )
        conflict_snapshot = _snapshot_from_rows(rows_after_conflict or [])
        if conflict_snapshot.state is not PermissionState.CONFIGURED:
            raise
        snapshot = _set_permission_cache(conflict_snapshot)
        return normalized in snapshot.admins, snapshot
    rows = execute_query(
        f"SELECT role, email FROM {table}",
        None,
        no_cache=True,
    )
    snapshot = _set_permission_cache(_snapshot_from_rows(rows or []))
    return normalized in snapshot.admins, snapshot


async def bootstrap_admin_atomic(request: Request) -> tuple[str, bool]:
    """Verify identity and atomically bootstrap exactly one durable administrator."""

    email = await resolve_verified_apps_identity(request)
    from server.db import get_catalog_schema

    catalog, schema = get_catalog_schema()
    if not catalog or not schema:
        first_claim = _read_provisional_setup_owner() is None
        if not _claim_provisional_setup_owner(email):
            raise HTTPException(
                status_code=409,
                detail="Initial setup has already been claimed by another user",
            )
        return email, first_claim
    try:
        won, snapshot = await asyncio.wait_for(
            asyncio.to_thread(bootstrap_admin_atomic_sync, email),
            timeout=_PERMISSION_READ_TIMEOUT_SECONDS,
        )
    except TimeoutError as exc:
        raise HTTPException(
            status_code=503,
            detail="Administrator bootstrap timed out",
        ) from exc
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Atomic administrator bootstrap failed: %s", exc)
        raise HTTPException(
            status_code=503,
            detail="Administrator bootstrap storage is unavailable",
        ) from exc
    if not won:
        raise HTTPException(
            status_code=409,
            detail="An administrator has already been configured",
        )
    _clear_provisional_setup_owner(email)
    return email, snapshot.admins[0] == email


_SENSITIVE_DIAGNOSTIC_KEYS = {
    "catalog",
    "schema",
    "host",
    "hostname",
    "http_path",
    "path",
    "client_id",
    "sp_client_id",
    "databricks_client_id",
    "databricks_host",
    "databricks_http_path",
}
_URL_PATTERN = re.compile(r"https?://[^\s\"']+", re.IGNORECASE)
_DBFS_PATH_PATTERN = re.compile(r"(?:dbfs:)?/[A-Za-z0-9_.\-/]+")
_UUID_PATTERN = re.compile(
    r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b",
    re.IGNORECASE,
)
_UC_IDENTIFIER_PART = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_-]*$")


def validate_uc_table_identifier(value: str) -> str:
    """Validate and normalize a strict three-part Unity Catalog table identifier."""

    normalized = str(value or "").strip()
    parts = normalized.split(".")
    if len(parts) != 3 or any(not _UC_IDENTIFIER_PART.fullmatch(part) for part in parts):
        raise ValueError(
            "Expected a three-part Unity Catalog identifier: catalog.schema.table"
        )
    return normalized


def redact_diagnostic_payload(value: Any) -> Any:
    """Remove deployment identifiers and raw backend errors from diagnostics."""

    if isinstance(value, dict):
        status = str(value.get("status") or "").lower()
        redacted: dict[str, Any] = {}
        for key, item in value.items():
            normalized_key = key.lower()
            if normalized_key in _SENSITIVE_DIAGNOSTIC_KEYS:
                continue
            if normalized_key in {"error", "errors", "raw_error", "exception"}:
                redacted[key] = "Diagnostic failed; inspect server logs."
                continue
            if normalized_key in {"detail", "message"} and status in {
                "fail",
                "error",
                "unavailable",
            }:
                redacted[key] = "Diagnostic failed; inspect server logs."
                continue
            redacted[key] = redact_diagnostic_payload(item)
        return redacted
    if isinstance(value, list):
        return [redact_diagnostic_payload(item) for item in value]
    if isinstance(value, tuple):
        return [redact_diagnostic_payload(item) for item in value]
    if isinstance(value, str):
        if value.strip().lower().startswith(("error:", "exception:", "traceback")):
            return "Diagnostic failed; inspect server logs."
        scrubbed = _URL_PATTERN.sub("[redacted-url]", value)
        scrubbed = _DBFS_PATH_PATTERN.sub("[redacted-path]", scrubbed)
        scrubbed = _UUID_PATTERN.sub("[redacted-id]", scrubbed)
        for env_name in (
            "DATABRICKS_CLIENT_ID",
            "DATABRICKS_HOST",
            "DATABRICKS_HTTP_PATH",
            "COST_OBS_CATALOG",
            "COST_OBS_SCHEMA",
        ):
            sensitive_value = os.getenv(env_name, "").strip()
            if sensitive_value:
                scrubbed = scrubbed.replace(sensitive_value, "[redacted]")
        return scrubbed
    return value

