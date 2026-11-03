"""Every billing endpoint must stay inside the admin-saved workspace scope."""

import re

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from server import workspace_filter
from server.routers import billing

SCOPED_DATA = re.compile(r"system\.billing\.usage|`?daily_\w+`?")
# Account ID and cloud name only; no spend.
ACCOUNT_LEVEL = {"/account-details"}
ENDPOINTS = sorted(
    {r.path for r in billing.router.routes if "GET" in getattr(r, "methods", set()) and "{" not in r.path}
    - ACCOUNT_LEVEL
)


@pytest.fixture
def sent(monkeypatch):
    calls: list[str] = []

    def _execute(sql, *args, **kwargs):
        calls.append(sql)
        return []

    monkeypatch.setattr(workspace_filter, "get_configured_workspace_ids", lambda: ["111"])
    monkeypatch.setattr(workspace_filter, "resolve_source_workspace_scope", lambda ids, labels=None: ids)
    monkeypatch.setattr(billing, "_execute_query", _execute)
    monkeypatch.setattr(billing, "get_workspace_client", lambda: (_ for _ in ()).throw(RuntimeError("offline")))
    monkeypatch.setattr(billing, "execute_queries_parallel", lambda qs, timeout=None, **_k: {k: fn() for k, fn in qs})
    return calls


@pytest.mark.parametrize("mv_available", [True, False])
@pytest.mark.parametrize("path", ENDPOINTS)
def test_billing_endpoint_only_reads_the_saved_scope(sent, monkeypatch, path, mv_available):
    monkeypatch.setattr(billing, "_check_mv_available", lambda: mv_available)
    app = FastAPI()
    app.include_router(billing.router, prefix="/api/billing")
    TestClient(app, raise_server_exceptions=False).get(f"/api/billing{path}")

    for sql in sent:
        if SCOPED_DATA.search(sql):
            assert "'111'" in sql, f"{path} read spend data outside the saved scope:\n{sql[:400]}"


def test_request_can_only_narrow_the_saved_pool(monkeypatch):
    monkeypatch.setattr(workspace_filter, "get_configured_workspace_ids", lambda: ["111", "222"])
    clause = workspace_filter.build_ws_filter_clause

    assert clause(id_list=["111", "999"]) == "AND CAST(u.workspace_id AS STRING) IN ('111')"
    assert clause(id_list=["999"]) == "AND 1 = 0"
    assert clause(single_id="999") == "AND 1 = 0"
    assert clause(single_id="222") == "AND CAST(u.workspace_id AS STRING) = '222'"


def test_scope_lands_on_every_branch_of_a_query():
    sql = "a AND u.usage_quantity > 0 b UNION ALL c AND u.usage_quantity > 0 d"
    assert workspace_filter.inject_ws_filter(sql, "AND x").count("AND x") == 2
