"""Workspace-scoping filter — reads COST_OBS_WORKSPACES env var or .settings/workspace_filter.json.

Set COST_OBS_WORKSPACES to a comma-separated list of workspace IDs to scope
the dashboard to specific workspaces only.  All workspaces are shown when the
variable is not set.

Example:
    COST_OBS_WORKSPACES=3233745148968388,1234567890123456
"""

import json
import logging
import os
import re

logger = logging.getLogger(__name__)

_cached_ids: list[str] | None = None

_SETTINGS_FILE = os.path.join(
    os.path.dirname(__file__), "..", ".settings", "workspace_filter.json"
)


def clear_cache() -> None:
    """Invalidate the cached workspace ID list so the next call re-reads from disk."""
    global _cached_ids
    _cached_ids = None


_SAFE_ID_RE = re.compile(r'^[a-zA-Z0-9_\-\.]+$')


def _is_safe_id(s: str) -> bool:
    """Accept numeric IDs and UUID/string workspace IDs; block anything that could inject SQL."""
    return bool(s and _SAFE_ID_RE.match(s))


def get_configured_workspace_ids() -> list[str]:
    """Return validated workspace IDs. Checks env var first, then settings file. Empty = no filter."""
    global _cached_ids
    if _cached_ids is None:
        raw = os.environ.get("COST_OBS_WORKSPACES", "").strip()
        if raw:
            parts = [w.strip() for w in raw.split(",") if w.strip()]
            valid = [p for p in parts if _is_safe_id(p)]
            invalid = sorted(set(parts) - set(valid))
            if invalid:
                logger.warning("COST_OBS_WORKSPACES: ignoring unsafe values: %s", invalid)
            _cached_ids = valid
        else:
            try:
                with open(_SETTINGS_FILE) as f:
                    data = json.load(f)
                ids = [str(i) for i in data.get("workspace_ids", []) if _is_safe_id(str(i))]
                _cached_ids = ids
            except (FileNotFoundError, json.JSONDecodeError):
                _cached_ids = []
    return _cached_ids


def build_ws_filter_clause(
    col: str = "u.workspace_id",
    single_id: str | None = None,
    id_list: list[str] | None = None,
) -> str:
    """Return a SQL AND clause for workspace filtering, or empty string.

    id_list   — list of IDs from multi-select; takes precedence over env/file config.
    single_id — single ID (legacy compat); takes precedence over env/file config.

    Uses STRING comparison so both numeric and UUID-format workspace IDs are handled correctly.
    """
    if id_list is not None:
        valid = [i for i in id_list if _is_safe_id(i)]
        if not valid:
            return ""
        quoted = ", ".join(f"'{i}'" for i in valid)
        return f"AND CAST({col} AS STRING) IN ({quoted})"
    if single_id and _is_safe_id(single_id):
        return f"AND CAST({col} AS STRING) = '{single_id}'"
    ids = get_configured_workspace_ids()
    if not ids:
        return ""
    quoted = ", ".join(f"'{i}'" for i in ids)
    return f"AND CAST({col} AS STRING) IN ({quoted})"


def is_workspace_scoped() -> bool:
    """True when workspace IDs restrict data to specific workspaces."""
    return bool(get_configured_workspace_ids())
