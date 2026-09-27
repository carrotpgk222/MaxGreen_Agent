"""Tests for the HTTP layer.

The important ones here are in TestNoUpstreamLeak: upstream exceptions from the LLM
gateway and the Google API can contain response bodies, model output and request URLs,
so they must be logged server-side and never returned to the client.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import app as app_module
from app import app

SECRET = "sk-live-DO-NOT-LEAK-abc123"


@pytest.fixture
def client():
    with TestClient(app, raise_server_exceptions=False) as test_client:
        yield test_client


class TestBasicRoutes:
    def test_root_reports_running(self, client):
        response = client.get("/")
        assert response.status_code == 200
        assert response.json()["status"] == "running"

    def test_health_shape(self, client):
        payload = client.get("/api/health").json()
        assert set(payload) == {"ok", "gmail_connected", "stored_messages"}
        assert payload["ok"] is True


class TestNoUpstreamLeak:
    """Regression tests: upstream error text must not reach the browser."""

    def test_llm_test_failure_does_not_echo_upstream(self, client, monkeypatch):
        from services.llm_service import LLMGatewayError

        def explode():
            raise LLMGatewayError(f"LLM gateway returned HTTP 401: invalid key {SECRET}")

        monkeypatch.setattr(app_module, "test_connection", explode)
        response = client.post("/api/llm/test")

        assert response.status_code == 502
        body = response.text
        assert SECRET not in body
        assert "401" not in body
        assert "gateway" in response.json()["detail"].lower()

    def test_gmail_sync_failure_does_not_echo_upstream(self, client, monkeypatch):
        def explode(*args, **kwargs):
            raise RuntimeError(f"token refresh failed for {SECRET}")

        monkeypatch.setattr(app_module, "is_connected", lambda: True)
        monkeypatch.setattr(app_module, "sync_gmail", explode)
        response = client.post("/api/gmail/sync")

        assert response.status_code == 500
        assert SECRET not in response.text
        assert response.json()["detail"] == "Gmail sync failed. Check the backend logs for details."

    def test_classify_failure_does_not_echo_upstream(self, client, monkeypatch):
        stored = {
            "gmail_message_id": "msg-leak",
            "ai_category": "Unclassified",
            "body_text": "hello",
            "attachments": [],
        }
        monkeypatch.setattr(app_module, "get_message", lambda _id: stored)
        monkeypatch.setattr(app_module, "update_message_classification", lambda *a, **k: None)

        def explode(_message):
            raise RuntimeError(f"model output was {SECRET}")

        monkeypatch.setattr(app_module, "classify_message", explode)
        response = client.post("/api/ai/classify/msg-leak")

        assert response.status_code == 502
        assert SECRET not in response.text
        assert response.json()["detail"] == "AI preparation failed. Check the backend logs for details."

    def test_classify_unclassified_reports_per_item_error_without_detail(self, client, monkeypatch):
        def explode(_message):
            raise RuntimeError(f"gateway said {SECRET}")

        monkeypatch.setattr(app_module, "list_unclassified_messages", lambda limit=10: [{"gmail_message_id": "m1"}])
        monkeypatch.setattr(app_module, "classify_message", explode)
        monkeypatch.setattr(app_module, "update_message_classification", lambda *a, **k: None)

        payload = client.post("/api/ai/classify-unclassified").json()
        assert payload["processed"] == 1
        failure = payload["results"][0]
        assert failure["ok"] is False
        assert SECRET not in str(payload)
        assert "backend logs" in failure["error"]

    def test_attachment_failure_does_not_echo_upstream(self, client, monkeypatch):
        message = {
            "gmail_message_id": "msg-1",
            "attachments": [{"attachment_id": "a1", "filename": "po.pdf", "mime_type": "application/pdf"}],
        }
        monkeypatch.setattr(app_module, "get_message", lambda _id: message)

        def explode(*args, **kwargs):
            raise RuntimeError(f"google api key {SECRET} rejected")

        monkeypatch.setattr(app_module, "fetch_attachment", explode)
        response = client.get("/api/gmail/messages/msg-1/attachments/a1")

        assert response.status_code == 500
        assert SECRET not in response.text

    def test_gmail_status_does_not_echo_upstream(self, client, monkeypatch):
        def explode():
            raise RuntimeError(f"refresh failed for {SECRET}")

        monkeypatch.setattr(app_module, "is_connected", lambda: True)
        monkeypatch.setattr(app_module, "get_profile", explode)
        payload = client.get("/api/gmail/status").json()

        assert payload["connected"] is False
        assert SECRET not in str(payload)


class TestValidation:
    def test_unknown_message_returns_404(self, client):
        assert client.get("/api/gmail/messages/nope").status_code == 404

    def test_invalid_category_returns_400_with_allowed_list(self, client, monkeypatch):
        monkeypatch.setattr(app_module, "get_message", lambda _id: {"gmail_message_id": "m1", "attachments": []})
        response = client.post("/api/gmail/messages/m1/category", json={"category": "Bogus"})
        assert response.status_code == 400
        assert "Supplier Payable" in response.json()["detail"]

    def test_missing_category_body_returns_422(self, client):
        assert client.post("/api/gmail/messages/m1/category", json={}).status_code == 422

    def test_sync_limit_is_bounded(self, client, monkeypatch):
        monkeypatch.setattr(app_module, "is_connected", lambda: False)
        assert client.post("/api/gmail/sync?limit=0").status_code == 422
        assert client.post("/api/gmail/sync?limit=999").status_code == 422

    def test_sync_without_gmail_returns_401(self, client, monkeypatch):
        monkeypatch.setattr(app_module, "is_connected", lambda: False)
        assert client.post("/api/gmail/sync").status_code == 401
