"""User endpoints."""

import asyncio
import json
import logging
import os
import time
from typing import Any

from fastapi import APIRouter, Request

router = APIRouter()
logger = logging.getLogger(__name__)

SETTINGS_DIR = os.path.join(os.path.dirname(__file__), "..", "..", ".settings")
USER_PERMISSIONS_FILE = os.path.join(SETTINGS_DIR, "user_permissions.json")

# In-memory TTL cache — avoids a Delta query on every authenticated request.
_perm_cache: dict = {}
_perm_cache_at: float = 0.0
_PERM_CACHE_TTL = 60.0  # seconds

# Service-principal display-name lookup — application_id -> display_name.
# Fetched via WorkspaceClient once per day since SPs rarely change; falls back
# to an empty map on SDK error so consumers can still render raw SP-<hex>.
# Failure path uses a short TTL so recovery (e.g. SCIM perms granted later)
# doesn't require a pod restart.
_sp_cache: dict[str, str] | None = None
_sp_cache_at: float = 0.0
_sp_cache_ok: bool = False
_SP_CACHE_TTL = 24 * 3600  # 24 hours on success
_SP_CACHE_FAIL_TTL = 300   # 5 minutes on failure — retry sooner


def _collect_sp_names(sp_iter) -> dict[str, str]:
    """Build application_id(lowercased) -> display_name from a SCIM SP iterator."""
    out: dict[str, str] = {}
    for sp in sp_iter:
        app_id = getattr(sp, "application_id", None)
        display = getattr(sp, "display_name", None)
        if app_id and display:
            out[str(app_id).lower()] = str(display)
    return out


def _list_service_principals_sync() -> dict[str, str]:
    """Build application_id -> display_name for service principals.

    Merges ACCOUNT-level SPs (the comprehensive source — `run_as` UUIDs in
    system.billing.usage are almost all account-wide SPs, which a workspace SCIM
    list does not see) with WORKSPACE-level SPs. Account resolution is best-effort:
    if no AccountClient can be built (no account admin, no account_id), we fall back
    to the workspace list alone so there is no regression from prior behavior.

    Keys are lowercased so lookups from the frontend (which sees SP UUIDs from
    system.billing.usage identity_metadata.run_as) match regardless of casing
    differences between SCIM and billing.

    Raises only if BOTH the account and workspace paths fail, so the caller's
    fail-TTL retry logic still engages on a total outage.
    """
    from server.db import get_account_client, get_workspace_client

    out: dict[str, str] = {}
    account_count = 0
    account_err: Exception | None = None
    workspace_err: Exception | None = None

    # 1) Account-level SPs first (comprehensive). Best-effort.
    try:
        a = get_account_client()
        if a is not None:
            out = _collect_sp_names(a.service_principals.list())
            account_count = len(out)
            logger.info("Fetched %d account-level service principals", account_count)
    except Exception as e:  # 403 (not account admin), transient SCIM error, etc.
        account_err = e
        logger.warning("Account service_principals.list() failed: %s", e)

    # 2) Overlay workspace-level SPs to fill any gaps (also the sole source when
    #    account access is unavailable). Workspace names win on conflict since a
    #    workspace-local SP display name is the more specific label.
    try:
        w = get_workspace_client()
        ws_names = _collect_sp_names(w.service_principals.list())
        out.update(ws_names)
        logger.info(
            "Merged %d workspace service principals (total %d, account contributed %d)",
            len(ws_names), len(out), account_count,
        )
    except Exception as e:
        workspace_err = e
        logger.warning("Workspace service_principals.list() failed: %s", e)

    # Only propagate failure if we got nothing from either source — that lets the
    # endpoint mark the result unavailable and retry on the short fail TTL.
    if not out and (account_err or workspace_err):
        raise (workspace_err or account_err)  # type: ignore[misc]
    return out


def _load_permissions() -> dict:
    """Load permissions from Delta table, then local file. Results cached for 60s.

    On Delta failure, returns the last known-good cached value so a transient
    warehouse blip does not temporarily grant everyone admin access.
    """
    global _perm_cache, _perm_cache_at

    now = time.monotonic()
    if _perm_cache and (now - _perm_cache_at) < _PERM_CACHE_TTL:
        return _perm_cache

    try:
        from server.db import execute_query, get_catalog_schema
        catalog, schema = get_catalog_schema()
        table = f"`{catalog}`.`{schema}`.`app_user_permissions`"
        rows = execute_query(f"SELECT role, email FROM {table}", None, no_cache=True)
        admins = [r["email"] for r in rows if r.get("role") == "admin"]
        consumers = [r["email"] for r in rows if r.get("role") == "consumer"]
        if admins or consumers:
            result = {"admins": admins, "consumers": consumers}
            _perm_cache = result
            _perm_cache_at = now
            return result
    except Exception as e:
        logger.error("Could not load permissions from Delta table: %s", e)
        if _perm_cache:
            logger.warning("Returning stale permission cache to avoid false-admin escalation")
            return _perm_cache

    # Fallback: local file (ephemeral, dev only)
    try:
        if os.path.exists(USER_PERMISSIONS_FILE):
            with open(USER_PERMISSIONS_FILE) as f:
                data = json.load(f)
            result = {"admins": data.get("admins", []), "consumers": data.get("consumers", [])}
            _perm_cache = result
            _perm_cache_at = now
            return result
    except (json.JSONDecodeError, IOError):
        pass
    return {"admins": [], "consumers": []}


def _get_user_role(email: str) -> str:
    """Return 'admin' or 'consumer' for the given email based on stored permissions."""
    perms = _load_permissions()
    if email in perms.get("admins", []):
        return "admin"
    if email in perms.get("consumers", []):
        return "consumer"
    # No admins configured yet (fresh deploy) — default everyone to admin
    # so the person who set up the app can immediately configure it.
    if not perms.get("admins"):
        return "admin"
    return "consumer"



@router.get("/me")
async def get_current_user(request: Request):
    """Get current user information."""
    # In Databricks Apps, user info comes from headers
    user_email = request.headers.get("X-Forwarded-Email", os.getenv("USER", "dev@local"))
    user_name = request.headers.get("X-Forwarded-User", user_email.split("@")[0] if "@" in user_email else user_email)

    return {
        "email": user_email,
        "name": user_name,
        "role": _get_user_role(user_email),
    }


@router.get("/service-principals")
async def get_service_principals() -> dict[str, Any]:
    """Return application_id -> display_name map for service principals.

    Cached for 24 hours since SP identities rarely change. Falls back to an
    empty map if the SDK call fails (missing SCIM permission, SP-less
    workspace, etc.) so callers can still render the SP-<hex> shortening
    without erroring.
    """
    global _sp_cache, _sp_cache_at, _sp_cache_ok
    now = time.monotonic()
    ttl = _SP_CACHE_TTL if _sp_cache_ok else _SP_CACHE_FAIL_TTL
    if _sp_cache is not None and (now - _sp_cache_at) < ttl:
        return {"map": _sp_cache, "available": _sp_cache_ok, "cached": True}

    try:
        result = await asyncio.to_thread(_list_service_principals_sync)
        _sp_cache = result
        _sp_cache_at = now
        _sp_cache_ok = True
        logger.info("Resolved %d service principal display names (account + workspace)", len(result))
        return {"map": result, "available": True, "cached": False}
    except Exception as e:
        logger.warning("service_principals.list() failed: %s", e)
        # Cache empty briefly so we don't hammer the SDK — retry after _SP_CACHE_FAIL_TTL.
        _sp_cache = {}
        _sp_cache_at = now
        _sp_cache_ok = False
        return {"map": {}, "available": False, "error": str(e)}
