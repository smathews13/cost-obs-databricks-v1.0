from pathlib import Path
from unittest.mock import patch

from server import db, materialized_views
from server.routers import settings

ROOT = Path(__file__).resolve().parents[2]


def test_dab_is_an_explicit_backup_not_the_primary_deployment():
    bundle = (ROOT / "databricks.yml").read_text()
    readme = (ROOT / "README.md").read_text()

    assert "backup:" in bundle
    assert "default: true" not in bundle
    assert "cost-observability-backup" in bundle
    assert "Deploy from Git remains the primary deployment path." in readme


def test_dab_reuses_the_runtime_and_injects_one_storage_location():
    app_resource = (ROOT / "resources" / "cost_obs.app.yml").read_text()

    assert "source_code_path: .." in app_resource
    assert "id: ${var.warehouse_id}" in app_resource
    assert "permission: CAN_USE" in app_resource
    assert "name: COST_OBS_CATALOG" in app_resource
    assert "value: ${var.catalog}" in app_resource
    assert "name: COST_OBS_SCHEMA" in app_resource
    assert "value: ${var.schema}" in app_resource
    assert "value_from: sql-warehouse" in app_resource


def test_git_manifest_remains_the_canonical_primary_contract():
    manifest = (ROOT / "app.yaml").read_text()

    assert "name: sql-warehouse" in manifest
    assert "valueFrom: sql-warehouse" in manifest
    assert "databricks.yml" not in manifest


def test_dab_upload_excludes_local_state_and_development_files():
    ignored = (ROOT / ".databricksignore").read_text().splitlines()

    for path in (
        ".env*",
        "*.deploy-bak",
        ".settings/",
        ".git/",
        "client/",
        "server/tests/",
        "databricks.yml",
        "resources/",
    ):
        assert path in ignored


def test_managed_table_inventory_covers_aggregates_state_and_cache():
    inventory = settings._managed_table_inventory()

    assert set(db.MV_UNIFIED_TABLE_NAMES).issubset(inventory)
    assert set(settings._APP_STATE_TABLES).issubset(inventory)
    assert settings._APP_RESPONSE_CACHE_TABLE in inventory
    assert len(inventory) == len(set(inventory))


def test_drop_inventory_matches_the_managed_state_contract():
    assert set(settings._APP_STATE_TABLES).issubset(
        materialized_views._APP_CONFIG_TABLES
    )
    assert settings._APP_RESPONSE_CACHE_TABLE in materialized_views._APP_CONFIG_TABLES


def test_workspace_filter_uses_the_namespaced_app_settings_schema():
    settings_source = (
        ROOT / "server" / "routers" / "settings.py"
    ).read_text()
    setup_source = (ROOT / "server" / "routers" / "setup.py").read_text()

    assert '"workspace_filter"' in settings_source
    assert '{"workspace_ids": workspace_ids}' in settings_source
    assert "_load_settings_namespace" in setup_source
    assert '"workspace_filter"' in setup_source
    assert "save_workspace_filter_to_table" in setup_source
    assert "app_workspace_filter" not in settings._APP_STATE_TABLES


def test_durable_routing_tables_validate_the_write_target():
    with (
        patch.object(db, "get_catalog_schema", return_value=("catalog", "schema")),
        patch.object(db, "validate_app_storage_target") as validate,
    ):
        assert db._mv_sources_table() == "`catalog`.`schema`.`app_mv_sources`"
        assert db._unified_views_table() == "`catalog`.`schema`.`app_unified_views`"

    assert validate.call_count == 2
