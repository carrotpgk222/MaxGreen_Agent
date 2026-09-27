"""The approval gate, the state machine, and duplicate-action prevention.

These are the tests that matter most in this repository: they assert that no
customer-facing or financial email can leave the system without a recorded human
approval, and that one document can never be sent twice.
"""

from __future__ import annotations

import base64

import pytest

from services import gmail_service
from services import workflow_service as ws
from services.security_service import ValidationError

# A patch target that must never be reached by an unapproved send.
RECIPIENT = "customer@example.com"


@pytest.fixture
def sent_calls(monkeypatch):
    """Replace the Gmail transport with a recorder. Counts calls, returns a fake id."""
    calls: list[dict] = []

    def fake_send_email(to, subject, body, attachments=None):
        calls.append({"to": to, "subject": subject, "body": body, "attachments": attachments or []})
        return {"id": f"gmail-{len(calls)}", "thread_id": "t1", "label_ids": ["SENT"]}

    monkeypatch.setattr(gmail_service, "send_email", fake_send_email)
    return calls


def make_document(**overrides):
    payload = {
        "document_type": "Quotation",
        "recipient_email": RECIPIENT,
        "subject": "Quotation for cleaning services",
        "body": "Dear customer, please find our quotation attached.",
        "payload": {"company": "Example Co", "items": [{"description": "Clean the lobby", "qty": 1}]},
        "actor": "operator@example.com",
    }
    payload.update(overrides)
    return ws.create_document(**payload)


def make_approved_document(**overrides):
    document = make_document(**overrides)
    ws.submit_for_approval(document["document_id"], actor="operator@example.com")
    return ws.approve_document(document["document_id"], actor="manager@example.com")


def _set_payload(document_id: str, payload: dict) -> None:
    """Edit a document's stored fields directly, as the reviewer's UI would."""
    import json

    with ws.get_connection() as conn:
        conn.execute(
            "UPDATE outbound_documents SET payload_json = ? WHERE document_id = ?",
            (json.dumps(payload), document_id),
        )


class TestApprovalBeforeSend:
    """The headline requirement."""

    def test_draft_cannot_be_sent(self, temp_db, sent_calls):
        document = make_document()
        with pytest.raises(ws.WorkflowError) as excinfo:
            ws.send_document(document["document_id"], actor="operator@example.com")
        assert excinfo.value.code == "not_approved"
        assert sent_calls == []
        assert ws.get_document(document["document_id"])["state"] == "Draft"

    def test_pending_approval_cannot_be_sent(self, temp_db, sent_calls):
        """Being queued for a reviewer is not the same as being approved."""
        document = make_document()
        ws.submit_for_approval(document["document_id"], actor="operator@example.com")
        with pytest.raises(ws.WorkflowError) as excinfo:
            ws.send_document(document["document_id"], actor="operator@example.com")
        assert excinfo.value.code == "not_approved"
        assert sent_calls == []

    def test_rejected_cannot_be_sent(self, temp_db, sent_calls):
        document = make_document()
        ws.submit_for_approval(document["document_id"], actor="operator@example.com")
        ws.reject_document(document["document_id"], actor="manager@example.com", reason="Wrong price")
        with pytest.raises(ws.WorkflowError) as excinfo:
            ws.send_document(document["document_id"], actor="operator@example.com")
        assert excinfo.value.code == "not_approved"
        assert sent_calls == []

    def test_sending_in_progress_cannot_be_sent_concurrently(self, temp_db, sent_calls):
        """A second request while the first holds the claim must not reach Gmail."""
        document = make_approved_document()
        # Simulate the first request having claimed the row but not yet finished.
        ws._transition(
            document["document_id"],
            expected_states={"Approved"},
            to_state="Sending",
            event="document.send.started",
            set_columns={"send_attempts": 1},
            actor="operator@example.com",
        )
        with pytest.raises(ws.WorkflowError) as excinfo:
            ws.send_document(document["document_id"], actor="operator@example.com")
        assert excinfo.value.code == "not_approved"
        assert sent_calls == []

    def test_approved_document_sends(self, temp_db, sent_calls):
        document = make_approved_document()
        result = ws.send_document(document["document_id"], actor="operator@example.com")
        assert result["ok"] is True
        assert result["duplicate_suppressed"] is False
        assert len(sent_calls) == 1
        assert sent_calls[0]["to"] == RECIPIENT
        assert ws.get_document(document["document_id"])["state"] == "Sent"

    def test_approval_requires_a_named_actor(self, temp_db, sent_calls):
        document = make_document()
        ws.submit_for_approval(document["document_id"], actor="operator@example.com")
        for blank in ("", "   ", None):
            with pytest.raises(ValidationError):
                ws.approve_document(document["document_id"], actor=blank)
        assert ws.get_document(document["document_id"])["state"] == "Pending Approval"
        assert sent_calls == []

    def test_approval_records_who_and_when(self, temp_db, sent_calls):
        document = make_approved_document()
        stored = ws.get_document(document["document_id"])
        assert stored["approved_by"] == "manager@example.com"
        assert stored["approved_at"]


class TestDuplicateSendPrevention:
    def test_second_send_returns_the_recorded_result_without_sending(self, temp_db, sent_calls):
        document = make_approved_document()
        first = ws.send_document(document["document_id"], actor="operator@example.com")
        second = ws.send_document(document["document_id"], actor="operator@example.com")
        assert first["duplicate_suppressed"] is False
        assert second["duplicate_suppressed"] is True
        assert len(sent_calls) == 1, "the transport must be called exactly once"
        assert second["sent_message_id"] == first["sent_message_id"]

    def test_repeated_sends_never_multiply_the_transport_calls(self, temp_db, sent_calls):
        document = make_approved_document()
        for _ in range(5):
            ws.send_document(document["document_id"], actor="operator@example.com")
        assert len(sent_calls) == 1

    def test_a_failed_send_can_be_retried_but_still_only_ends_up_sent_once(
        self, temp_db, monkeypatch
    ):
        attempts: list[int] = []

        def flaky_send(to, subject, body, attachments=None):
            attempts.append(1)
            if len(attempts) == 1:
                raise gmail_service.GmailSendError(
                    "Gmail did not accept the message.", code="send_transport_failed", retryable=True
                )
            return {"id": "gmail-ok", "thread_id": "t", "label_ids": ["SENT"]}

        monkeypatch.setattr(gmail_service, "send_email", flaky_send)
        document = make_approved_document()

        with pytest.raises(ws.WorkflowError):
            ws.send_document(document["document_id"], actor="operator@example.com")
        assert ws.get_document(document["document_id"])["state"] == "Send Failed"

        # Retry is allowed without a fresh approval: the approval already covers this content.
        result = ws.send_document(document["document_id"], actor="operator@example.com")
        assert result["ok"] is True
        assert ws.get_document(document["document_id"])["state"] == "Sent"

        # And the retry after success is still suppressed.
        again = ws.send_document(document["document_id"], actor="operator@example.com")
        assert again["duplicate_suppressed"] is True
        assert len(attempts) == 2

    def test_failed_send_is_never_recorded_as_sent(self, temp_db, monkeypatch):
        monkeypatch.setattr(
            gmail_service,
            "send_email",
            lambda *a, **k: (_ for _ in ()).throw(
                gmail_service.GmailSendError("nope", code="send_transport_failed", retryable=True)
            ),
        )
        document = make_approved_document()
        with pytest.raises(ws.WorkflowError):
            ws.send_document(document["document_id"], actor="operator@example.com")
        stored = ws.get_document(document["document_id"])
        assert stored["state"] == "Send Failed"
        assert not stored["sent_at"]
        assert stored["sent_message_id"] == ""


class TestStateMachine:
    def test_submit_rejects_an_incomplete_document(self, temp_db):
        document = make_document(payload={"company": "", "items": []})
        with pytest.raises(ws.WorkflowError) as excinfo:
            ws.submit_for_approval(document["document_id"], actor="operator@example.com")
        assert excinfo.value.code == "incomplete_document"
        assert excinfo.value.status_code == 422
        assert any("Company" in problem for problem in excinfo.value.details)
        assert any("Items" in problem for problem in excinfo.value.details)

    def test_invoice_requires_prices_and_quantities(self, temp_db):
        document = make_document(
            document_type="Invoice",
            payload={"items": [{"description": "Clean the lobby", "qty": None, "unit_price": None}]},
        )
        with pytest.raises(ws.WorkflowError) as excinfo:
            ws.submit_for_approval(document["document_id"], actor="operator@example.com")
        joined = " ".join(excinfo.value.details)
        assert "unit price" in joined
        assert "quantity" in joined

    def test_invoice_without_a_document_number_cannot_be_submitted(self, temp_db):
        document = make_document(
            document_type="Invoice",
            document_number="",
            payload={"items": [{"description": "Clean", "qty": 1, "unit_price": 10}]},
        )
        # create_document auto-allocates, so clear it to model a document edited in the UI.
        ws._transition(
            document["document_id"],
            expected_states={"Draft"},
            to_state="Draft",
            event="document.number.cleared",
            set_columns={"document_number": ""},
            actor="operator@example.com",
        )
        with pytest.raises(ws.WorkflowError) as excinfo:
            ws.submit_for_approval(document["document_id"], actor="operator@example.com")
        assert any("document number" in problem.lower() for problem in excinfo.value.details)

    def test_cannot_approve_a_draft(self, temp_db):
        document = make_document()
        with pytest.raises(ws.WorkflowError) as excinfo:
            ws.approve_document(document["document_id"], actor="manager@example.com")
        assert excinfo.value.code == "invalid_state"
        assert excinfo.value.status_code == 409

    def test_cannot_approve_twice(self, temp_db):
        document = make_approved_document()
        with pytest.raises(ws.WorkflowError):
            ws.approve_document(document["document_id"], actor="someone-else@example.com")

    def test_rejection_requires_a_reason(self, temp_db):
        document = make_document()
        ws.submit_for_approval(document["document_id"], actor="operator@example.com")
        with pytest.raises(ValidationError):
            ws.reject_document(document["document_id"], actor="manager@example.com", reason="  ")

    def test_rejected_document_can_be_resubmitted_after_a_fix(self, temp_db):
        document = make_document()
        ws.submit_for_approval(document["document_id"], actor="operator@example.com")
        ws.reject_document(document["document_id"], actor="manager@example.com", reason="Wrong scope")

        # A reviewer clears the payload in the UI, which the backend then refuses to submit.
        _set_payload(document["document_id"], {"company": "Example Co", "items": []})
        with pytest.raises(ws.WorkflowError) as excinfo:
            ws.submit_for_approval(document["document_id"], actor="operator@example.com")
        assert excinfo.value.code == "incomplete_document"

        # After the fix, the same document goes back into the approval queue.
        _set_payload(document["document_id"], {"company": "Example Co", "items": [{"description": "Clean lobby"}]})
        updated = ws.submit_for_approval(document["document_id"], actor="operator@example.com")
        assert updated["state"] == "Pending Approval"

    def test_fields_are_revalidated_at_send_time(self, temp_db, sent_calls):
        """A document edited after approval must not go out with the fields it was cleared for."""
        document = make_approved_document()
        with ws.get_connection() as conn:
            conn.execute(
                "UPDATE outbound_documents SET recipient_email = ? WHERE document_id = ?",
                ("", document["document_id"]),
            )
        with pytest.raises(ws.ValidationError):
            ws.send_document(document["document_id"], actor="operator@example.com")
        assert sent_calls == []


class TestModelOutputCannotAuthorise:
    def test_low_confidence_source_is_flagged_for_review(self, temp_db):
        document = make_document(source_confidence=0.1)
        assert document["needs_human_review"] is True
        # Flagged for review, but it still requires the ordinary approval path.
        assert ws.get_document(document["document_id"])["state"] == "Draft"

    def test_missing_confidence_counts_as_low(self, temp_db):
        assert make_document(source_confidence=None)["needs_human_review"] is True

    def test_prompt_injection_source_requires_an_explicit_override(self, temp_db, sent_calls):
        document = make_approved_document(source_security_status="Prompt Injection")
        with pytest.raises(ws.WorkflowError) as excinfo:
            ws.send_document(document["document_id"], actor="operator@example.com")
        assert excinfo.value.code == "override_required"
        assert excinfo.value.status_code == 403
        assert sent_calls == []

    def test_override_allows_the_send_and_is_audited(self, temp_db, sent_calls):
        document = make_approved_document(source_security_status="Prompt Injection")

        # The first, un-overridden attempt is refused and recorded in the audit trail.
        with pytest.raises(ws.WorkflowError):
            ws.send_document(document["document_id"], actor="operator@example.com")
        assert sent_calls == []

        result = ws.send_document(
            document["document_id"], actor="operator@example.com", force_override=True
        )
        assert result["ok"] is True
        assert len(sent_calls) == 1
        events = [item["event"] for item in ws.list_events(document["document_id"])]
        assert "document.send.blocked" in events
        assert events[-1] == "document.send.succeeded"

    def test_override_does_not_bypass_approval(self, temp_db, sent_calls):
        """force_override relaxes the injection check, never the approval check."""
        document = make_document(source_security_status="Prompt Injection")
        with pytest.raises(ws.WorkflowError) as excinfo:
            ws.send_document(
                document["document_id"], actor="operator@example.com", force_override=True
            )
        assert excinfo.value.code == "not_approved"
        assert sent_calls == []


class TestDocumentNumbers:
    def test_numbers_are_allocated_per_type_per_day(self, temp_db):
        first = make_document()
        second = make_document()
        assert first["document_number"] != second["document_number"]
        assert first["document_number"].startswith("MGQ.")

    def test_invoice_uses_its_own_prefix_and_sequence(self, temp_db):
        quotation = make_document()
        invoice = make_document(
            document_type="Invoice",
            payload={"items": [{"description": "Clean", "qty": 1, "unit_price": 10}]},
        )
        assert invoice["document_number"].startswith("INV.")
        assert quotation["document_number"] != invoice["document_number"]

    def test_duplicate_document_number_is_refused(self, temp_db):
        number = make_document()["document_number"]
        with pytest.raises(ws.WorkflowError) as excinfo:
            make_document(document_number=number)
        assert excinfo.value.code == "duplicate_document_number"
        assert excinfo.value.status_code == 409

    def test_same_number_is_allowed_for_a_different_type(self, temp_db):
        number = make_document()["document_number"]
        invoice = make_document(
            document_type="Invoice",
            document_number=number,
            payload={"items": [{"description": "Clean", "qty": 1, "unit_price": 10}]},
        )
        assert invoice["document_number"] == number

    def test_created_documents_never_share_a_number(self, temp_db):
        """The number is reserved by the insert, so 25 live documents get 25 numbers.

        ``allocate_document_number`` alone may repeat a value: it is a *next candidate*
        lookup, and a candidate that is never created simply leaves a gap. The invariant
        that matters - no two stored documents collide - is enforced by the unique index
        and re-checked here from the database.
        """
        for _ in range(25):
            make_document()

        with ws.get_connection() as conn:
            numbers = [row["document_number"] for row in conn.execute(
                "SELECT document_number FROM outbound_documents"
            ).fetchall()]
        assert len(numbers) == 25
        assert len(set(numbers)) == 25

    def test_malformed_number_is_refused(self, temp_db):
        with pytest.raises(ws.ValidationError):
            make_document(document_number="MGQ 26/1; DROP TABLE")


class TestInputValidation:
    @pytest.mark.parametrize("bad", ["", "not-an-email", "a@b", "a@b.com, c@d.com", "a@b.com\nBcc: x@y.com"])
    def test_invalid_recipient_is_refused(self, temp_db, bad):
        with pytest.raises(ValidationError):
            make_document(recipient_email=bad)

    def test_recipient_with_crlf_header_injection_is_refused(self, temp_db):
        with pytest.raises(ValidationError) as excinfo:
            make_document(recipient_email="victim@example.com\r\nBcc: attacker@evil.test")
        assert excinfo.value.code == "invalid_address"

    def test_subject_with_a_newline_is_refused(self, temp_db):
        with pytest.raises(ValidationError):
            make_document(subject="Hello\r\nBcc: attacker@evil.test")

    def test_empty_body_is_refused(self, temp_db):
        with pytest.raises(ValidationError):
            make_document(body="   ")

    def test_oversized_body_is_refused(self, temp_db):
        with pytest.raises(ValidationError) as excinfo:
            make_document(body="x" * 300_000)
        assert excinfo.value.code == "too_large"

    def test_unsupported_document_type_is_refused(self, temp_db):
        with pytest.raises(ValidationError) as excinfo:
            make_document(document_type="Purchase Order")
        assert excinfo.value.code == "unsupported_type"

    def test_filename_is_sanitised_into_the_payload(self, temp_db):
        document = make_document(
            payload={
                "company": "Example Co",
                "items": [{"description": "Clean"}],
                "attachments": [
                    {
                        "filename": "../../../etc/passwd",
                        "mime_type": "application/pdf",
                        "gmail_message_id": "m1",
                        "attachment_id": "a1",
                    }
                ],
            }
        )
        described = document["attachments"][0]
        assert described["filename"] == "passwd"
        assert ".." not in described["filename"]
        assert "/" not in described["filename"]


class TestAuditTrail:
    def test_every_transition_is_recorded_in_order(self, temp_db, sent_calls):
        document = make_approved_document()
        ws.send_document(document["document_id"], actor="operator@example.com")
        events = [item["event"] for item in ws.list_events(document["document_id"])]
        assert events == [
            "document.created",
            "document.submitted",
            "document.approved",
            "document.send.started",
            "document.send.succeeded",
        ]

    def test_blocked_send_is_audited(self, temp_db, sent_calls):
        document = make_document()
        with pytest.raises(ws.WorkflowError):
            ws.send_document(document["document_id"], actor="operator@example.com")
        events = [item["event"] for item in ws.list_events(document["document_id"])]
        assert "document.send.blocked" in events

    def test_blocked_send_audit_records_the_actor(self, temp_db, sent_calls):
        document = make_document()
        with pytest.raises(ws.WorkflowError):
            ws.send_document(document["document_id"], actor="someone@example.com")
        blocked = [item for item in ws.list_events(document["document_id"]) if item["event"].endswith("blocked")]
        assert blocked and blocked[-1]["actor"] == "someone@example.com"

    def test_audit_records_do_not_contain_the_document_body(self, temp_db):
        document = make_document(body="SECRET-CUSTOMER-DETAIL-XYZ")
        events = str(ws.list_events(document["document_id"]))
        assert "SECRET-CUSTOMER-DETAIL-XYZ" not in events


class TestSendTransportContract:
    def test_send_receives_validated_addresses(self, temp_db, sent_calls):
        document = make_approved_document()
        ws.send_document(document["document_id"], actor="operator@example.com")
        assert sent_calls[0]["to"] == RECIPIENT

    def test_send_failure_raises_a_clear_error_without_upstream_text(self, temp_db, monkeypatch):
        monkeypatch.setattr(
            gmail_service,
            "send_email",
            lambda *a, **k: (_ for _ in ()).throw(
                gmail_service.GmailSendError(
                    "Gmail did not accept the message.",
                    code="send_transport_failed",
                    retryable=True,
                    safe_detail="HttpError status=403",
                )
            ),
        )
        document = make_approved_document()
        with pytest.raises(ws.WorkflowError) as excinfo:
            ws.send_document(document["document_id"], actor="operator@example.com")
        assert "403" not in excinfo.value.message
        assert "try again" in excinfo.value.message.lower()

    def test_an_unexpected_transport_error_does_not_strand_the_document(self, temp_db, monkeypatch):
        """A claimed document must always leave ``Sending``.

        Anything the transport can throw that is not a known, handled error - a socket
        timeout, a Google client bug, a bad attachment payload - used to escape the send
        with the row still in ``Sending``. Nothing can retry from that state, so the
        document was permanently stuck. The catch-all turns it into a retryable failure.
        """
        monkeypatch.setattr(
            gmail_service,
            "send_email",
            lambda *a, **k: (_ for _ in ()).throw(TimeoutError("connection reset by peer")),
        )
        document = make_approved_document()

        with pytest.raises(ws.WorkflowError) as excinfo:
            ws.send_document(document["document_id"], actor="operator@example.com")

        assert excinfo.value.code == "send_error"
        assert "connection reset" not in excinfo.value.message
        stored = ws.get_document(document["document_id"])
        assert stored["state"] == "Send Failed"
        assert stored["last_error_code"] == "send_error"

    def test_an_unexpected_attachment_error_does_not_strand_the_document(self, temp_db, monkeypatch):
        """Attachment handling sits inside the claim, so its failures are covered too."""
        document = make_approved_document(
            payload={
                "company": "Example Co",
                "items": [{"description": "Clean lobby"}],
                "attachments": [
                    {
                        "filename": "quote.pdf",
                        "mime_type": "application/pdf",
                        "gmail_message_id": "m1",
                        "attachment_id": "a1",
                    }
                ],
            }
        )
        monkeypatch.setattr(
            gmail_service,
            "fetch_attachment",
            lambda *a, **k: (_ for _ in ()).throw(RuntimeError("Gmail said no")),
        )
        with pytest.raises(ws.WorkflowError):
            ws.send_document(document["document_id"], actor="operator@example.com")
        assert ws.get_document(document["document_id"])["state"] == "Send Failed"



class TestGeneratedAttachments:
    """A PDF rendered in the browser has no Gmail source, so its bytes are stored.

    Before this, the frontend generated the document PDF and posted it to an unguarded
    endpoint that dropped it on the floor. The bytes now travel with the document and are
    attached at send time, without opening a path around the approval gate.
    """

    PDF_BYTES = b"%PDF-1.4\n% generated quotation\n%%EOF"

    def _pdf(self) -> str:
        return base64.b64encode(self.PDF_BYTES).decode("ascii")

    def test_a_generated_pdf_is_attached_to_the_send(self, temp_db, sent_calls):
        document = make_approved_document(
            attachments=[
                {"filename": "MGQ-1.pdf", "mime_type": "application/pdf", "data": self._pdf()}
            ]
        )
        result = ws.send_document(document["document_id"], actor="operator@example.com")

        assert result["ok"] is True
        assert len(sent_calls) == 1
        attachments = sent_calls[0]["attachments"]
        assert len(attachments) == 1
        assert attachments[0]["filename"] == "MGQ-1.pdf"
        assert attachments[0]["data"] == self.PDF_BYTES

    def test_the_base64_body_never_reaches_the_stored_payload(self, temp_db):
        """The payload is returned by API calls and written near the audit trail."""
        document = make_document(
            attachments=[
                {"filename": "MGQ-1.pdf", "mime_type": "application/pdf", "data": self._pdf()}
            ]
        )
        stored = ws.get_document(document["document_id"])
        assert self.PDF_BYTES.decode() not in str(stored)
        assert self._pdf() not in str(stored)
        # The descriptor still names the file, so the UI can show what will be attached.
        assert stored["attachments"][0]["filename"] == "MGQ-1.pdf"

    def test_a_generated_pdf_still_needs_approval(self, temp_db, sent_calls):
        document = make_document(
            attachments=[
                {"filename": "MGQ-1.pdf", "mime_type": "application/pdf", "data": self._pdf()}
            ]
        )
        with pytest.raises(ws.WorkflowError) as excinfo:
            ws.send_document(document["document_id"], actor="operator@example.com")
        assert excinfo.value.code == "not_approved"
        assert sent_calls == []

    def test_a_generated_pdf_is_sanitised_before_storage(self, temp_db, sent_calls):
        document = make_approved_document(
            attachments=[
                {
                    "filename": "../../../etc/passwd.pdf",
                    "mime_type": "application/pdf",
                    "data": self._pdf(),
                }
            ]
        )
        ws.send_document(document["document_id"], actor="operator@example.com")
        assert sent_calls[0]["attachments"][0]["filename"] == "passwd.pdf"

    def test_an_active_content_type_is_refused(self, temp_db):
        """HTML and SVG are how an attachment becomes active content in a mail client."""
        for mime in ("text/html", "image/svg+xml", "application/x-msdownload"):
            with pytest.raises(ValidationError) as excinfo:
                make_document(
                    attachments=[
                        {"filename": "x", "mime_type": mime, "data": self._pdf()}
                    ]
                )
            assert excinfo.value.code == "unsupported_type"

    def test_a_non_base64_body_is_refused(self, temp_db):
        with pytest.raises(ValidationError) as excinfo:
            make_document(
                attachments=[{"filename": "x.pdf", "mime_type": "application/pdf", "data": "not base64!!!"}]
            )
        assert excinfo.value.code == "invalid_encoding"

    def test_an_empty_attachment_is_refused(self, temp_db):
        with pytest.raises(ValidationError) as excinfo:
            make_document(
                attachments=[{"filename": "x.pdf", "mime_type": "application/pdf", "data": "  "}]
            )
        assert excinfo.value.code == "empty_attachment"

    def test_an_oversized_attachment_is_refused_before_decoding_pressure(self, temp_db):
        with pytest.raises(ValidationError) as excinfo:
            make_document(
                attachments=[
                    {
                        "filename": "big.pdf",
                        "mime_type": "application/pdf",
                        "data": "A" * (16 * 1024 * 1024 * 2),
                    }
                ]
            )
        assert excinfo.value.code == "too_large"

    def test_too_many_attachments_are_refused(self, temp_db):
        with pytest.raises(ValidationError) as excinfo:
            make_document(
                attachments=[
                    {"filename": f"f{i}.pdf", "mime_type": "application/pdf", "data": self._pdf()}
                    for i in range(11)
                ]
            )
        assert excinfo.value.code == "too_many"

    def test_a_missing_stored_attachment_fails_the_send_without_stranding_it(
        self, temp_db, sent_calls
    ):
        """Attachment resolution happens after the claim, so it must release the row."""
        document = make_approved_document(
            attachments=[
                {"filename": "MGQ-1.pdf", "mime_type": "application/pdf", "data": self._pdf()}
            ]
        )
        with ws.get_connection() as conn:
            conn.execute("DELETE FROM document_attachments")

        with pytest.raises(ws.WorkflowError) as excinfo:
            ws.send_document(document["document_id"], actor="operator@example.com")

        assert excinfo.value.code == "attachment_missing"
        assert sent_calls == []
        assert ws.get_document(document["document_id"])["state"] == "Send Failed"
