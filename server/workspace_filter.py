"""Workspace-scoping filter — reads COST_OBS_WORKSPACES env var.

Set COST_OBS_WORKSPACES to a comma-separated list of workspace IDs to scope
the dashboard to specific workspaces only.  All workspaces are shown when the
variable is not set.

Example:
    COST_OBS_WORKSPACES=3233745148968388,1234567890123456
"""

import logging
import os

logger = logging.getLogger(__name__)

_cached_ids: list[str] | None = None


def get_configured_workspace_ids() -> list[str]:
    """Return validated workspace IDs from env var.  Empty list = no filter."""
    global _cached_ids
    if _cached_ids is None:
        raw = os.environ.get("COST_OBS_WORKSPACES", "").strip()
        if not raw:
            _cached_ids = []
        else:
            parts = [w.strip() for w in raw.split(",") if w.strip()]
            valid = [p for p in parts if p.lstrip("-").isdigit()]
            invalid = sorted(set(parts) - set(valid))
            if invalid:
                logger.warning("COST_OBS_WORKSPACES: ignoring non-numeric values: %s", invalid)
            _cached_ids = valid
    return _cached_ids


def build_ws_filter_clause(col: str = "u.workspace_id", single_id: str | None = None) -> str:
    """Return a SQL AND clause for workspace filtering, or empty string.

    single_id — when provided (user dropdown selection) filter to exactly that
                workspace.  Must be a numeric string; takes precedence over the
                env-var list.
    """
    if single_id and single_id.lstrip("-").isdigit():
        return f"AND CAST({col} AS BIGINT) = {single_id}"
    ids = get_configured_workspace_ids()
    if not ids:
        return ""
    return f"AND CAST({col} AS BIGINT) IN ({', '.join(ids)})"


def is_workspace_scoped() -> bool:
    """True when COST_OBS_WORKSPACES restricts data to specific workspaces."""
    return bool(get_configured_workspace_ids())
