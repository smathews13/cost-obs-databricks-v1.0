import asyncio
import json
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from server.routers import settings


class _Request:
    headers: dict[str, str] = {}

    def __init__(self, body: dict | None = None):
        self._body = body or {}

    async def json(self) -> dict:
        return self._body


def test_architecture_view_setting_defaults_and_sanitizes_to_boolean():
    assert settings._APP_SETTINGS_DEFAULTS["enable_architecture_view"] is True
    assert "enable_architecture_view" in settings._APP_SETTINGS_ALLOWED
    assert settings._sanitize_app_settings({})["enable_architecture_view"] is True
    assert settings._sanitize_app_settings({"enable_architecture_view": True})["enable_architecture_view"] is True
    assert settings._sanitize_app_settings({"enable_architecture_view": "true"})["enable_architecture_view"] is True


def test_architecture_view_setting_is_in_unified_snapshot():
    with (
        patch.object(settings, "get_app_settings", return_value={
            **settings._APP_SETTINGS_DEFAULTS,
            "enable_architecture_view": True,
        }),
        patch.object(settings, "_load_alert_thresholds", return_value={}),
        patch.object(settings, "_load_pricing_settings", return_value={}),
        patch.object(settings, "load_schedule_settings", return_value={}),
        patch.object(settings, "_webhook_masked", return_value={}),
        patch.object(settings, "_capabilities", return_value={}),
    ):
        snapshot = settings._settings_snapshot(_Request())

    assert snapshot["experimental"]["enable_architecture_view"] is True


def test_unified_put_dispatches_architecture_view_setting():
    request = _Request({"experimental": {"enable_architecture_view": True}})
    with (
        patch.object(settings, "_require_admin"),
        patch.object(settings, "save_app_settings") as save,
        patch.object(settings, "_settings_snapshot") as snapshot,
    ):
        result = asyncio.run(settings.put_unified_settings(request))

    save.assert_called_once_with({"enable_architecture_view": True})
    snapshot.assert_not_called()
    assert result == {
        "status": "saved",
        "updated_count": 1,
        "domains": {"app": {"ok": True}},
    }


def test_unified_put_tab_only_skips_thresholds_webhook_and_snapshot():
    request = _Request({"tab_visibility": {"infra": False}})
    with (
        patch.object(settings, "_require_admin"),
        patch.object(settings, "save_app_settings") as save_app,
        patch.object(settings, "_load_alert_thresholds") as load_thresholds,
        patch.object(settings, "_save_alert_thresholds") as save_thresholds,
        patch.object(settings, "_save_webhook_settings") as save_webhook,
        patch.object(settings, "_settings_snapshot") as snapshot,
    ):
        result = asyncio.run(settings.put_unified_settings(request))

    save_app.assert_called_once_with({"tab_visibility": {"infra": False}})
    load_thresholds.assert_not_called()
    save_thresholds.assert_not_called()
    save_webhook.assert_not_called()
    snapshot.assert_not_called()
    assert result == {
        "status": "saved",
        "updated_count": 1,
        "domains": {"app": {"ok": True}},
    }


def test_unified_put_allows_clearing_webhook():
    request = _Request({"webhook": {"slack_webhook_url": ""}})
    with (
        patch.object(settings, "_require_admin"),
        patch.object(settings, "_save_webhook_settings") as save_webhook,
        patch.object(settings, "save_app_settings") as save_app,
    ):
        result = asyncio.run(settings.put_unified_settings(request))

    save_webhook.assert_called_once_with({"slack_webhook_url": ""})
    save_app.assert_not_called()
    assert result == {
        "status": "saved",
        "updated_count": 1,
        "domains": {"webhook": {"ok": True}},
    }


def test_save_app_settings_persists_architecture_view_to_delta_and_file(tmp_path):
    file_path = tmp_path / "app_settings.json"
    writes: list[tuple[str, dict | None]] = []

    def capture_write(sql: str, params: dict | None = None):
        writes.append((sql, params))

    with (
        patch.object(settings, "APP_SETTINGS_FILE", str(file_path)),
        patch.object(settings, "get_app_settings", return_value=dict(settings._APP_SETTINGS_DEFAULTS)),
        patch.object(settings, "_ensure_app_settings_table"),
        patch.object(settings, "_config_table", return_value="`catalog`.`schema`.`app_settings`"),
        patch("server.db.execute_write", side_effect=capture_write),
    ):
        saved = settings.save_app_settings({
            "enable_architecture_view": True,
            "not_an_allowed_setting": True,
        })

    assert saved["enable_architecture_view"] is True
    assert "not_an_allowed_setting" not in saved
    persisted = json.loads(file_path.read_text())
    assert persisted["enable_architecture_view"] is True
    delta_params = next(
        params for sql, params in writes if "MERGE INTO" in sql and params
    )
    assert delta_params["id"] == "app"
    delta_payload = delta_params["settings_json"]
    assert json.loads(delta_payload)["enable_architecture_view"] is True


def test_save_app_settings_writes_local_fallback_but_raises_when_delta_fails(tmp_path):
    file_path = tmp_path / "app_settings.json"

    with (
        patch.object(settings, "APP_SETTINGS_FILE", str(file_path)),
        patch.object(settings, "get_app_settings", return_value=dict(settings._APP_SETTINGS_DEFAULTS)),
        patch.object(settings, "_ensure_app_settings_table"),
        patch.object(settings, "_config_table", return_value="`catalog`.`schema`.`app_settings`"),
        patch("server.db.execute_write", side_effect=RuntimeError("warehouse unavailable")),
    ):
        with pytest.raises(settings.AppSettingsDurabilityError, match="not saved durably"):
            settings.save_app_settings({
                "enable_architecture_view": True,
                "tab_visibility": {"dbu": True, "infra": False},
            })

    persisted = json.loads(file_path.read_text())
    assert persisted["enable_architecture_view"] is True
    assert persisted["tab_visibility"]["infra"] is False


def test_unified_put_returns_503_when_app_settings_are_not_durable():
    request = _Request({
        "general": {"theme": "dark"},
        "tab_visibility": {"dbu": True, "infra": False},
        "experimental": {"enable_architecture_view": True},
    })
    with (
        patch.object(settings, "_require_admin"),
        patch.object(
            settings,
            "save_app_settings",
            side_effect=settings.AppSettingsDurabilityError("Delta unavailable"),
        ) as save,
        patch.object(settings, "_settings_snapshot") as snapshot,
    ):
        with pytest.raises(HTTPException) as exc_info:
            asyncio.run(settings.put_unified_settings(request))

    assert exc_info.value.status_code == 503
    assert exc_info.value.detail == {
        "status": "partial_failure",
        "updated_count": 0,
        "domains": {"app": {"ok": False, "error": "Delta unavailable"}},
    }
    save.assert_called_once()
    saved_partial = save.call_args.args[0]
    assert saved_partial["theme"] == "dark"
    assert saved_partial["tab_visibility"]["infra"] is False
    assert saved_partial["enable_architecture_view"] is True
    snapshot.assert_not_called()
