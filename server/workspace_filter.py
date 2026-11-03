"""Workspace-scoping filter — reads COST_OBS_WORKSPACES env var or .settings/workspace_filter.json.

Set COST_OBS_WORKSPACES to a comma-separated list of workspace IDs to scope
the dashboard to specific workspaces only.  All workspaces are shown when the
variable is not set.

Example:
    COST_OBS_WORKSPACES=<workspace-id>[,<workspace-id>]
"""

import json
import logging
import os
import re
from contextvars import ContextVar

logger = logging.getLogger(__name__)

_SETTINGS_FILE = os.path.join(
    os.path.dirname(__file__), "..", ".settings", "workspace_filter.json"
)

_SAFE_ID_RE = re.compile(r'^[a-zA-Z0-9_\-\.]+$')
EMPTY_WORKSPACE_SCOPE_ID = "source-scope-no-overlap"
_include_historical_workspaces: ContextVar[bool] = ContextVar(
    "include_historical_workspaces",
    default=True,
)


def set_include_historical_workspaces(include: bool) -> object:
    return _include_historical_workspaces.set(bool(include))


def reset_include_historical_workspaces(token: object) -> None:
    try:
        _include_historical_workspaces.reset(token)  # type: ignore[arg-type]
    except Exception:
        pass


def include_historical_workspaces() -> bool:
    return _include_historical_workspaces.get()


def _is_safe_id(s: str) -> bool:
    """Accept numeric IDs and UUID/string workspace IDs; block anything that could inject SQL."""
    return bool(s and _SAFE_ID_RE.match(s))


def clear_cache() -> None:
    """No-op — kept for call-site compatibility. Cache was removed to fix multi-worker staleness."""
    pass


def get_configured_workspace_ids() -> list[str]:
    """Return validated workspace IDs. Checks env var first, then settings file. Empty = no filter.

    Always reads from source (no in-process cache) so every uvicorn worker sees fresh data
    immediately after the admin saves a new pool without a server restart.
    """
    raw = os.environ.get("COST_OBS_WORKSPACES", "").strip()
    if raw:
        parts = [w.strip() for w in raw.split(",") if w.strip()]
        valid = [p for p in parts if _is_safe_id(p)]
        invalid = sorted(set(parts) - set(valid))
        if invalid:
            logger.warning("COST_OBS_WORKSPACES: ignoring unsafe values: %s", invalid)
        return valid
    try:
        with open(_SETTINGS_FILE) as f:
            data = json.load(f)
        return [str(i) for i in data.get("workspace_ids", []) if _is_safe_id(str(i))]
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def build_ws_filter_clause(
    col: str = "u.workspace_id",
    single_id: str | None = None,
    id_list: list[str] | None = None,
) -> str:
    """Return a SQL AND clause for workspace filtering, or empty string.

    id_list   — list of IDs from multi-select; narrows the env/file pool.
    single_id — single ID (legacy compat); narrows the env/file pool.

    A request can only narrow the admin-saved pool, never widen it.
    Uses STRING comparison so both numeric and UUID-format workspace IDs are handled correctly.
    """
    pool = get_configured_workspace_ids()
    if id_list is not None or single_id:
        requested = id_list if id_list is not None else [single_id]
        if EMPTY_WORKSPACE_SCOPE_ID in requested:
            return "AND 1 = 0"
        valid = [i for i in requested if _is_safe_id(i)]
        if pool:
            allowed = set(pool)
            valid = [i for i in valid if i in allowed]
        if not valid:
            return "AND 1 = 0"
        if len(valid) == 1 and id_list is None:
            return f"AND CAST({col} AS STRING) = '{valid[0]}'"
        quoted = ", ".join(f"'{i}'" for i in valid)
        return f"AND CAST({col} AS STRING) IN ({quoted})"
    ids = pool
    if ids:
        quoted = ", ".join(f"'{i}'" for i in ids)
        return f"AND CAST({col} AS STRING) IN ({quoted})"
    if not include_historical_workspaces():
        return (
            f"AND EXISTS ("
            "SELECT 1 FROM system.access.workspaces_latest AS current_ws "
            f"WHERE CAST(current_ws.workspace_id AS STRING) = CAST({col} AS STRING)"
            ")"
        )
    return ""


def resolve_source_workspace_scope(
    id_list: list[str] | None,
    source_labels: list[str] | None = None,
) -> list[str] | None:
    """Intersect a request workspace scope with persisted shared-source mappings.

    Local data can honor the caller's workspace scope directly. Shared-only
    requests fail closed when a source has no mapping, and otherwise use the
    union of mapped workspaces intersected with any explicit request IDs.
    """
    from server.db import get_local_source_label, get_mv_sources, selected_source_labels

    labels = list(dict.fromkeys(source_labels or selected_source_labels()))
    if not labels:
        return id_list
    local_label = get_local_source_label()
    if local_label in labels:
        return id_list

    configured = {
        str(source.get("label") or ""): source
        for source in get_mv_sources()
    }
    mapped_ids: set[str] = set()
    for label in labels:
        source = configured.get(label)
        source_ids = {
            str(value).strip()
            for value in ((source or {}).get("workspace_ids") or [])
            if str(value).strip()
        }
        if not source_ids:
            return [EMPTY_WORKSPACE_SCOPE_ID]
        mapped_ids.update(source_ids)

    if id_list is None:
        return sorted(mapped_ids)
    requested = {
        value for value in id_list
        if value != EMPTY_WORKSPACE_SCOPE_ID
    }
    intersection = sorted(requested.intersection(mapped_ids))
    return intersection or [EMPTY_WORKSPACE_SCOPE_ID]


def is_workspace_scoped() -> bool:
    """True when workspace IDs restrict data to specific workspaces."""
    return bool(get_configured_workspace_ids())


def inject_ws_filter(sql: str, clause: str) -> str:
    """Inject workspace filter clause after every usage_quantity guard in a billing SQL string."""
    if not clause:
        return sql
    for anchor in ("AND u.usage_quantity > 0", "AND usage_quantity > 0"):
        if anchor in sql:
            return sql.replace(anchor, f"{anchor}\n    {clause}")
    return sql
