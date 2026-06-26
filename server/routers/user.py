"""User endpoints."""

import json
import logging
import os
import time

from fastapi import APIRouter, Request

router = APIRouter()
logger = logging.getLogger(__name__)

SETTINGS_DIR = os.path.join(os.path.dirname(__file__), "..", "..", ".settings")
USER_PERMISSIONS_FILE = os.path.join(SETTINGS_DIR, "user_permissions.json")

# In-memory TTL cache — avoids a Delta query on every authenticated request.
_perm_cache: dict = {}
_perm_cache_at: float = 0.0
_PERM_CACHE_TTL = 60.0  # seconds


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
