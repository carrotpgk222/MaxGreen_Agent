"""HTTP-layer tests for the approval workflow and the request-validation guards.

These exercise the same paths the browser uses, so they catch the class of bug where the
service layer is correct but the endpoint forgets to pass an argument, validates the wrong
value, or leaks an internal message.
"""

from __future__ import annotations

import base64

import pytest
from fastapi.testclient import TestClient

import services.workflow_service as workflow_service
from app import app


@pytest.fixture
def client():
    with TestClient(app, raise_server_exceptions=False) as test_client:
        yield test_client


@pytest.fixture
def no_sends(monkeypatch):
    """Make any send attempt fail loudly if the endpoint reaches the transport."""
    calls: list[dict] = []

    def forbidden(**kwargs):
        calls.append(kwargs)
        raise AssertionError("the transport must not be reached in this test")

    monkeypatch.setattr("services.gmail_service.send_email", forbidden)
    return calls


class TestDocumentCreation:
    def test_create_returns_a_draft_that_is_not_yet_approved(self, client, temp_db):
        response = client.post(
            "/api/documents",
            json={
                "document_type": "Quotation",
                "recipient_email": "customer@example.com",
                "subject": "Quotation for the lobby clean",
                "body": "Please find our quotation attached.",
                "payload": {"company": "Example Co", "items": [{"description": "Clean lobby"}]},
                "actor": "operator@example.com",
            },
        )
        assert response.status_code == 201
        document = response.json()["document"]
        assert document["state"] == "Draft"
        assert document["document_number"].startswith("MGQ.")
        # The create response is a summary: the body is only in the detail endpoint.
        assert "body" not in document

    def test_invalid_recipient_is_422_not_500(self, client, temp_db):
        response = client.post(
            "/api/documents",
            json={
                "document_type": "Quotation",
                "recipient_email": "a@b.com, c@d.com",
                "subject": "Hi",
                "body": "Body",
            },
        )
        assert response.status_code == 422
        assert "backend logs" not in response.text.lower()

    def test_unsupported_document_type_is_422(self, client, temp_db):
        response = client.post(
            "/api/documents",
            json={
                "document_type": "Purchase Order",
                "recipient_email": "customer@example.com",
                "subject": "Hi",
                "body": "Body",
            },
        )
        assert response.status_code == 422


class TestApprovalGateOverHttp:
    def test_draft_cannot_be_sent(self, client, temp_db, no_sends):
        document = _create(client)
        response = client.post(f"/api/documents/{document['document_id']}/send", json={"actor": "op@example.com"})
        assert response.status_code == 409
        assert response.json()["code"] == "not_approved"
        assert no_sends == []

    def test_full_approval_then_send_succeeds(self, client, temp_db, monkeypatch):
        sent: list[dict] = []
        monkeypatch.setattr(
            "services.gmail_service.send_email",
            lambda **kwargs: sent.append(kwargs) or {"id": "gmail-1"},
        )
        document = _create(client)

        for action, body in (
            ("submit", {"actor": "op@example.com"}),
            ("approve", {"actor": "manager@example.com"}),
            ("send", {"actor": "op@example.com"}),
        ):
            response = client.post(
                f"/api/documents/{document['document_id']}/{action}", json=body
            )
            assert response.status_code == 200, (action, response.text)

        assert len(sent) == 1
        final = client.get(f"/api/documents/{document['document_id']}").json()["document"]
        assert final["state"] == "Sent"
        assert final["sent_message_id"] == "gmail-1"

    def test_repeat_send_is_idempotent_over_http(self, client, temp_db, monkeypatch):
        sent: list[dict] = []
        monkeypatch.setattr(
            "services.gmail_service.send_email",
            lambda **kwargs: sent.append(kwargs) or {"id": "gmail-1"},
        )
        document = _create(client)
        client.post(f"/api/documents/{document['document_id']}/submit", json={"actor": "op@example.com"})
        client.post(f"/api/documents/{document['document_id']}/approve", json={"actor": "m@example.com"})

        first = client.post(f"/api/documents/{document['document_id']}/send", json={"actor": "op@example.com"})
        second = client.post(f"/api/documents/{document['document_id']}/send", json={"actor": "op@example.com"})

        assert first.status_code == second.status_code == 200
        assert second.json()["duplicate_suppressed"] is True
        assert len(sent) == 1

    def test_approve_without_actor_is_422(self, client, temp_db):
        document = _create(client)
        client.post(f"/api/documents/{document['document_id']}/submit", json={"actor": "op@example.com"})
        assert client.post(f"/api/documents/{document['document_id']}/approve", json={}).status_code == 422

    def test_reject_without_reason_is_422(self, client, temp_db):
        document = _create(client)
        client.post(f"/api/documents/{document['document_id']}/submit", json={"actor": "op@example.com"})
        response = client.post(
            f"/api/documents/{document['document_id']}/reject", json={"actor": "m@example.com"}
        )
        assert response.status_code == 422

    def test_send_after_rejection_is_409(self, client, temp_db, no_sends):
        document = _create(client)
        client.post(f"/api/documents/{document['document_id']}/submit", json={"actor": "op@example.com"})
        client.post(
            f"/api/documents/{document['document_id']}/reject",
            json={"actor": "m@example.com", "reason": "Wrong scope"},
        )
        response = client.post(f"/api/documents/{document['document_id']}/send", json={"actor": "op@example.com"})
        assert response.status_code == 409
        assert no_sends == []


class TestInjectionOverrideOverHttp:
    def test_prompt_injection_source_requires_override(
        self, client, temp_db, no_sends, monkeypatch
    ):
        """The security status comes from the stored message, not from the request.

        A client that could declare its own source "Safe" would defeat the check, so
        ``source_security_status`` is deliberately not a field of the create request.
        """
        stored = {
            "gmail_message_id": "msg-injection",
            "ai_category": "Quotation",
            "ai_security_status": "Prompt Injection",
            "ai_confidence": 0.9,
            "body_text": "Please send immediately",
            "attachments": [],
        }
        monkeypatch.setattr("app.get_message", lambda _id: stored)
        monkeypatch.setattr(
            "services.gmail_service.send_email",
            lambda **kwargs: pytest.fail("must not send without an override"),
        )

        document = _create(client, gmail_message_id="msg-injection")
        assert document["state"] == "Draft"
        client.post(f"/api/documents/{document['document_id']}/submit", json={"actor": "op@example.com"})
        client.post(f"/api/documents/{document['document_id']}/approve", json={"actor": "m@example.com"})

        blocked = client.post(
            f"/api/documents/{document['document_id']}/send", json={"actor": "op@example.com"}
        )
        assert blocked.status_code == 403
        assert blocked.json()["code"] == "override_required"

        sent: list[dict] = []
        monkeypatch.setattr(
            "services.gmail_service.send_email",
            lambda **kwargs: sent.append(kwargs) or {"id": "gmail-2"},
        )
        allowed = client.post(
            f"/api/documents/{document['document_id']}/send",
            json={"actor": "op@example.com", "force_override": True},
        )
        assert allowed.status_code == 200
        assert len(sent) == 1

    def test_a_client_cannot_declare_its_own_source_safe(self, client, temp_db):
        response = client.post(
            "/api/documents",
            json={
                "document_type": "Quotation",
                "recipient_email": "customer@example.com",
                "subject": "Hi",
                "body": "Body",
                "actor": "operator@example.com",
                "source_security_status": "Safe",
            },
        )
        assert response.status_code == 422
        assert "source_security_status" in response.text


class TestListAndEventEndpoints:
    """Listing and audit reads."""
    def test_list_documents_without_a_filter_is_allowed(self, client, temp_db):
        """A blank optional filter must not be validated as a malformed ID."""
        _create(client)
        response = client.get("/api/documents")
        assert response.status_code == 200
        assert len(response.json()["documents"]) == 1

    def test_list_documents_with_a_malformed_filter_is_422(self, client, temp_db):
        assert client.get("/api/documents?gmail_message_id=../../etc/passwd").status_code == 422

    def test_list_documents_hides_the_body(self, client, temp_db):
        _create(client)
        document = client.get("/api/documents").json()["documents"][0]
        assert "body" not in document
        assert "payload" not in document

    def test_events_endpoint_returns_the_audit_trail(self, client, temp_db):
        document = _create(client)
        client.post(f"/api/documents/{document['document_id']}/submit", json={"actor": "op@example.com"})
        payload = client.get(f"/api/documents/{document['document_id']}/events").json()
        assert [event["event"] for event in payload["events"]] == [
            "document.created",
            "document.submitted",
        ]

    def test_unknown_document_returns_404(self, client, temp_db):
        assert client.get("/api/documents/does-not-exist").status_code == 404
        assert client.post("/api/documents/does-not-exist/approve", json={"actor": "m@e.com"}).status_code == 404

    def test_path_traversal_in_a_document_id_is_rejected(self, client, temp_db):
        assert client.get("/api/documents/..%2F..%2Fetc%2Fpasswd").status_code in (404, 422)


class TestRequestGuards:
    def test_error_response_never_contains_upstream_text(self, client, temp_db, monkeypatch):
        def explode(**kwargs):
            raise RuntimeError("google refresh failed for sk-live-DO-NOT-LEAK-abc123")

        monkeypatch.setattr("services.gmail_service.send_email", explode)
        document = _create(client)
        client.post(f"/api/documents/{document['document_id']}/submit", json={"actor": "op@example.com"})
        client.post(f"/api/documents/{document['document_id']}/approve", json={"actor": "m@example.com"})

        response = client.post(f"/api/documents/{document['document_id']}/send", json={"actor": "op@example.com"})

        assert response.status_code == 502
        assert "DO-NOT-LEAK" not in response.text
        # The claim must have been released, so the document is retryable rather than stuck.
        stored = workflow_service.get_document(document["document_id"])
        assert stored["state"] == "Send Failed"

    def test_send_failure_is_retryable_and_only_sends_once_more(self, client, temp_db, monkeypatch):
        calls: list[int] = []

        def flaky(**kwargs):
            calls.append(1)
            if len(calls) == 1:
                raise RuntimeError("transient network failure")
            return {"id": "gmail-3"}

        monkeypatch.setattr("services.gmail_service.send_email", flaky)
        document = _create(client)
        client.post(f"/api/documents/{document['document_id']}/submit", json={"actor": "op@example.com"})
        client.post(f"/api/documents/{document['document_id']}/approve", json={"actor": "m@example.com"})

        first = client.post(f"/api/documents/{document['document_id']}/send", json={"actor": "op@example.com"})
        assert first.status_code == 502
        second = client.post(f"/api/documents/{document['document_id']}/send", json={"actor": "op@example.com"})

        assert second.status_code == 200
        assert len(calls) == 2
        assert workflow_service.get_document(document["document_id"])["state"] == "Sent"

    def test_every_response_carries_a_request_id(self, client):
        for path in ("/", "/api/health", "/api/documents"):
            response = client.get(path)
            assert response.headers.get("X-Request-ID")


class TestAttribution:
    def test_every_state_change_needs_an_actor(self, client, temp_db):
        """Each mutating call is attributable; a request without an actor is refused."""
        response = client.post(
            "/api/documents",
            json={
                "document_type": "Quotation",
                "recipient_email": "customer@example.com",
                "subject": "Hi",
                "body": "Body",
            },
        )
        assert response.status_code == 422
        assert "actor" in response.text

    def test_approve_rejects_an_unknown_field(self, client, temp_db):
        document = _create(client)
        client.post(f"/api/documents/{document['document_id']}/submit", json={"actor": "op@example.com"})
        response = client.post(
            f"/api/documents/{document['document_id']}/approve",
            json={"actor": "m@example.com", "approved": True},
        )
        assert response.status_code == 422


def _create(client, **overrides) -> dict:
    body = {
        "document_type": "Quotation",
        "recipient_email": "customer@example.com",
        "subject": "Quotation for the lobby clean",
        "body": "Please find our quotation attached.",
        "payload": {"company": "Example Co", "items": [{"description": "Clean lobby"}]},
        "actor": "operator@example.com",
    }
    body.update(overrides)
    response = client.post("/api/documents", json=body)
    assert response.status_code == 201, response.text
    return response.json()["document"]


class TestGeneratedAttachmentOverHttp:
    """The browser-generated PDF now travels with the document instead of a raw send."""

    PDF = base64.b64encode(b"%PDF-1.4\n% quotation\n%%EOF").decode("ascii")

    def test_a_pdf_is_accepted_and_never_echoed_back(self, client, temp_db, monkeypatch):
        sent: list[dict] = []
        monkeypatch.setattr(
            "services.gmail_service.send_email",
            lambda **kwargs: sent.append(kwargs) or {"id": "gmail-pdf"},
        )
        response = client.post(
            "/api/documents",
            json={
                "document_type": "Quotation",
                "recipient_email": "customer@example.com",
                "subject": "Quotation",
                "body": "Please find the quotation attached.",
                "payload": {"company": "Example Co", "items": [{"description": "Clean lobby"}]},
                "actor": "operator@example.com",
                "attachments": [
                    {"filename": "MGQ-1.pdf", "mime_type": "application/pdf", "data": self.PDF}
                ],
            },
        )
        assert response.status_code == 201
        # The base64 must not come back in the response body.
        assert self.PDF not in response.text

        document_id = response.json()["document"]["document_id"]
        for action, body in (
            ("submit", {"actor": "op@example.com"}),
            ("approve", {"actor": "manager@example.com"}),
            ("send", {"actor": "op@example.com"}),
        ):
            assert client.post(f"/api/documents/{document_id}/{action}", json=body).status_code == 200

        assert len(sent) == 1
        assert sent[0]["attachments"][0]["data"].startswith(b"%PDF")

    def test_an_html_attachment_is_refused(self, client, temp_db):
        response = client.post(
            "/api/documents",
            json={
                "document_type": "Quotation",
                "recipient_email": "customer@example.com",
                "subject": "Quotation",
                "body": "Body",
                "actor": "operator@example.com",
                "attachments": [
                    {"filename": "x.html", "mime_type": "text/html", "data": self.PDF}
                ],
            },
        )
        assert response.status_code == 422

    def test_more_than_ten_attachments_are_refused(self, client, temp_db):
        response = client.post(
            "/api/documents",
            json={
                "document_type": "Quotation",
                "recipient_email": "customer@example.com",
                "subject": "Quotation",
                "body": "Body",
                "actor": "operator@example.com",
                "attachments": [
                    {"filename": f"f{i}.pdf", "mime_type": "application/pdf", "data": self.PDF}
                    for i in range(11)
                ],
            },
        )
        assert response.status_code == 422


class TestDirectSend:
    """POST /api/gmail/send: one step, but not an unvalidated one.

    The operator composes and sends in a single action, so there is no approval step. What
    must still hold is that the request cannot inject headers, smuggle an active-content
    attachment, or leak an upstream failure to the browser.
    """

    PDF = base64.b64encode(b"%PDF-1.4\n% quotation\n%%EOF").decode("ascii")

    @pytest.fixture
    def connected(self, monkeypatch):
        monkeypatch.setattr("app.is_connected", lambda: True)

    @pytest.fixture
    def transport(self, monkeypatch):
        sent: list[dict] = []
        monkeypatch.setattr(
            "app.send_email",
            lambda **kwargs: sent.append(kwargs) or {"id": "gmail-direct", "thread_id": "t9"},
        )
        return sent

    def test_a_plain_email_sends_in_one_request(self, client, connected, transport):
        response = client.post(
            "/api/gmail/send",
            json={"to": "customer@example.com", "subject": "Quotation", "body": "Hello"},
        )
        assert response.status_code == 200
        assert response.json() == {"ok": True, "message_id": "gmail-direct", "thread_id": "t9"}
        assert len(transport) == 1
        assert transport[0]["to"] == "customer@example.com"

    def test_the_generated_pdf_is_actually_attached(self, client, connected, transport):
        """The old endpoint accepted attachments and silently dropped them."""
        response = client.post(
            "/api/gmail/send",
            json={
                "to": "customer@example.com",
                "subject": "Quotation",
                "body": "Please find the quotation attached.",
                "attachments": [
                    {"filename": "MGQ-1.pdf", "mime_type": "application/pdf", "data": self.PDF}
                ],
            },
        )
        assert response.status_code == 200
        attachments = transport[0]["attachments"]
        assert len(attachments) == 1
        assert attachments[0]["filename"] == "MGQ-1.pdf"
        assert attachments[0]["data"] == b"%PDF-1.4\n% quotation\n%%EOF"

    def test_crlf_in_the_recipient_is_refused(self, client, connected, transport):
        response = client.post(
            "/api/gmail/send",
            json={
                "to": "victim@example.com\r\nBcc: attacker@evil.test",
                "subject": "Quotation",
                "body": "Hello",
            },
        )
        assert response.status_code == 422
        assert transport == []

    def test_crlf_in_the_subject_is_refused(self, client, connected, transport):
        response = client.post(
            "/api/gmail/send",
            json={
                "to": "customer@example.com",
                "subject": "Hello\r\nBcc: attacker@evil.test",
                "body": "Hello",
            },
        )
        assert response.status_code == 422
        assert transport == []

    def test_a_second_recipient_in_the_to_field_is_refused(self, client, connected, transport):
        response = client.post(
            "/api/gmail/send",
            json={"to": "a@example.com, b@example.com", "subject": "Quotation", "body": "Hello"},
        )
        assert response.status_code == 422
        assert transport == []

    def test_active_content_attachments_are_refused(self, client, connected, transport):
        for mime in ("text/html", "image/svg+xml", "application/x-msdownload"):
            response = client.post(
                "/api/gmail/send",
                json={
                    "to": "customer@example.com",
                    "subject": "Quotation",
                    "body": "Hello",
                    "attachments": [{"filename": "x", "mime_type": mime, "data": self.PDF}],
                },
            )
            assert response.status_code == 422, mime
        assert transport == []

    def test_an_attachment_filename_is_sanitised(self, client, connected, transport):
        response = client.post(
            "/api/gmail/send",
            json={
                "to": "customer@example.com",
                "subject": "Quotation",
                "body": "Hello",
                "attachments": [
                    {"filename": "../../../etc/passwd.pdf", "mime_type": "application/pdf", "data": self.PDF}
                ],
            },
        )
        assert response.status_code == 200
        assert transport[0]["attachments"][0]["filename"] == "passwd.pdf"

    def test_an_oversized_attachment_is_refused(self, client, connected, transport):
        response = client.post(
            "/api/gmail/send",
            json={
                "to": "customer@example.com",
                "subject": "Quotation",
                "body": "Hello",
                "attachments": [
                    {
                        "filename": "big.pdf",
                        "mime_type": "application/pdf",
                        "data": "A" * (16 * 1024 * 1024 * 2),
                    }
                ],
            },
        )
        assert response.status_code == 422
        assert transport == []

    def test_an_oversized_body_is_refused(self, client, connected, transport):
        response = client.post(
            "/api/gmail/send",
            json={"to": "customer@example.com", "subject": "Quotation", "body": "x" * 300_000},
        )
        assert response.status_code == 422
        assert transport == []

    def test_an_unknown_field_is_refused(self, client, connected, transport):
        """A typo must not be silently dropped on the way to a customer."""
        response = client.post(
            "/api/gmail/send",
            json={"to": "customer@example.com", "subject": "Quotation", "body": "Hi", "bcc": "a@b.com"},
        )
        assert response.status_code == 422
        assert transport == []

    def test_disconnected_gmail_returns_401(self, client, monkeypatch):
        monkeypatch.setattr("app.is_connected", lambda: False)
        response = client.post(
            "/api/gmail/send",
            json={"to": "customer@example.com", "subject": "Quotation", "body": "Hi"},
        )
        assert response.status_code == 401

    def test_an_upstream_failure_never_reaches_the_client(self, client, connected, monkeypatch):
        def explode(**kwargs):
            raise RuntimeError("token refresh failed for sk-live-DO-NOT-LEAK-abc123")

        monkeypatch.setattr("app.send_email", explode)
        response = client.post(
            "/api/gmail/send",
            json={"to": "customer@example.com", "subject": "Quotation", "body": "Hi"},
        )
        assert response.status_code == 502
        assert "DO-NOT-LEAK" not in response.text
        assert "try again" in response.json()["detail"].lower()

    def test_a_rejected_message_is_a_422_and_says_not_to_retry(self, client, connected, monkeypatch):
        from services.gmail_service import GmailSendError

        def reject(**kwargs):
            raise GmailSendError(
                "Gmail rejected the message.",
                code="send_rejected",
                retryable=False,
                safe_detail="HttpError status=403 insufficientPermissions",
            )

        monkeypatch.setattr("app.send_email", reject)
        response = client.post(
            "/api/gmail/send",
            json={"to": "customer@example.com", "subject": "Quotation", "body": "Hi"},
        )
        assert response.status_code == 422
        assert response.json()["code"] == "send_rejected"
        assert "403" not in response.text

    def test_a_retryable_failure_is_a_502(self, client, connected, monkeypatch):
        from services.gmail_service import GmailSendError

        def flaky(**kwargs):
            raise GmailSendError(
                "Gmail is unavailable.",
                code="send_unavailable",
                retryable=True,
                safe_detail="HttpError status=503 backendError",
            )

        monkeypatch.setattr("app.send_email", flaky)
        response = client.post(
            "/api/gmail/send",
            json={"to": "customer@example.com", "subject": "Quotation", "body": "Hi"},
        )
        assert response.status_code == 502
        assert "503" not in response.text

    def test_the_recipient_address_is_not_logged(self, client, connected, transport, caplog):
        with caplog.at_level("INFO"):
            client.post(
                "/api/gmail/send",
                json={
                    "to": "very-private-customer@example.com",
                    "subject": "Confidential quotation 12345",
                    "body": "SECRET-BODY-CONTENT",
                },
            )
        logged = "\n".join(record.getMessage() for record in caplog.records)
        assert "very-private-customer@example.com" not in logged
        assert "SECRET-BODY-CONTENT" not in logged
        assert "Confidential quotation" not in logged
