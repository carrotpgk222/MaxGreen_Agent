"""Tests for the LLM gateway client and the background scheduler's configuration parsing.

Only pure/offline behaviour is exercised: no network calls, no real credentials.
"""

from __future__ import annotations

import pytest

from services import llm_service, scheduler_service


class TestStripMarkdownFence:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ('```json\n{"a": 1}\n```', '{"a": 1}'),
            ('```\n{"a": 1}\n```', '{"a": 1}'),
            ('```JSON\n{"a": 1}\n```', '{"a": 1}'),
            ('{"a": 1}', '{"a": 1}'),
        ],
    )
    def test_removes_the_fence(self, raw, expected):
        assert llm_service._strip_markdown_fence(raw) == expected

    def test_does_not_trim_surrounding_whitespace(self):
        """This helper only unwraps fences; `json.loads` tolerates the padding later on."""
        assert llm_service._strip_markdown_fence('  {"a": 1}  ') == '  {"a": 1}  '


class TestParseJsonContent:
    def test_parses_plain_json(self):
        assert llm_service.parse_json_content('{"status": "ok"}') == {"status": "ok"}

    def test_parses_fenced_json(self):
        assert llm_service.parse_json_content('```json\n{"status": "ok"}\n```') == {"status": "ok"}

    def test_raises_on_empty_content(self):
        with pytest.raises(llm_service.LLMGatewayError):
            llm_service.parse_json_content("")

    def test_raises_on_prose_instead_of_json(self):
        with pytest.raises(llm_service.LLMGatewayError):
            llm_service.parse_json_content("Sure! Here is the JSON you asked for.")

    def test_raises_when_no_object_is_present(self):
        with pytest.raises(llm_service.LLMGatewayError):
            llm_service.parse_json_content("[1, 2, 3] only an array")


class TestConfigValidation:
    def test_missing_keys_are_reported_by_name(self, monkeypatch):
        for name in ("LLM_GATEWAY_URL", "LLM_GATEWAY_API_KEY", "LLM_MODEL"):
            monkeypatch.delenv(name, raising=False)
        with pytest.raises(llm_service.LLMGatewayError) as excinfo:
            llm_service._config()
        message = str(excinfo.value)
        for name in ("LLM_GATEWAY_URL", "LLM_GATEWAY_API_KEY", "LLM_MODEL"):
            assert name in message

    def test_is_configured_is_false_when_incomplete(self, monkeypatch):
        for name in ("LLM_GATEWAY_URL", "LLM_GATEWAY_API_KEY", "LLM_MODEL"):
            monkeypatch.delenv(name, raising=False)
        assert llm_service.is_configured() is False

    def test_trailing_slash_is_normalised(self, monkeypatch):
        monkeypatch.setenv("LLM_GATEWAY_URL", "https://gateway.example.com/")
        monkeypatch.setenv("LLM_GATEWAY_API_KEY", "k")
        monkeypatch.setenv("LLM_MODEL", "m")
        base_url, api_key, model = llm_service._config()
        assert base_url == "https://gateway.example.com"
        assert (api_key, model) == ("k", "m")

    def test_blank_values_count_as_missing(self, monkeypatch):
        monkeypatch.setenv("LLM_GATEWAY_URL", "   ")
        monkeypatch.setenv("LLM_GATEWAY_API_KEY", "k")
        monkeypatch.setenv("LLM_MODEL", "m")
        assert llm_service.is_configured() is False


class TestSchedulerConfigParsing:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [("30", 30), ("5", 5), ("1", 5), ("0", 5), ("-99", 5), ("600", 600), ("abc", 30), ("", 30)],
    )
    def test_interval_has_a_floor_and_a_fallback(self, monkeypatch, raw, expected):
        monkeypatch.setenv("GMAIL_POLL_INTERVAL_SECONDS", raw)
        assert scheduler_service._interval_seconds() == expected

    @pytest.mark.parametrize(
        ("raw", "expected"),
        [("10", 10), ("0", 1), ("-5", 1), ("999", 100), ("abc", 10), ("", 10)],
    )
    def test_sync_limit_is_clamped(self, monkeypatch, raw, expected):
        monkeypatch.setenv("GMAIL_POLL_LIMIT", raw)
        assert scheduler_service._sync_limit() == expected

    def test_sync_query_defaults_to_inbox(self, monkeypatch):
        monkeypatch.delenv("GMAIL_SYNC_QUERY", raising=False)
        assert scheduler_service._sync_query() == "in:inbox"

    def test_sync_query_is_overridable(self, monkeypatch):
        monkeypatch.setenv("GMAIL_SYNC_QUERY", "is:unread")
        assert scheduler_service._sync_query() == "is:unread"
