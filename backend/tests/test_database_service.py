"""Tests for the SQLite layer.

Every test runs against a throwaway database via the `temp_db` fixture, so the real
`backend/data/maxgreen.db` is never touched.
"""

from __future__ import annotations

from services import database_service as db


class TestSchema:
    def test_init_db_creates_the_table(self, temp_db):
        with db.get_connection() as conn:
            names = {row["name"] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert "gmail_messages" in names

    def test_init_db_is_idempotent(self, temp_db):
        db.init_db()
        db.init_db()
        with db.get_connection() as conn:
            cols = {row["name"] for row in conn.execute("PRAGMA table_info(gmail_messages)")}
        assert "ai_category" in cols

    def test_all_ai_columns_are_present(self, temp_db):
        """_ensure_ai_columns must add every column the services read and write."""
        with db.get_connection() as conn:
            cols = {row["name"] for row in conn.execute("PRAGMA table_info(gmail_messages)")}
        expected = {
            "ai_category",
            "ai_party_type",
            "ai_security_status",
            "ai_confidence",
            "ai_reason",
            "ai_quotation_refs_json",
            "ai_model",
            "ai_classified_at",
            "ai_supplier_reference",
            "ai_amount",
            "ai_due_date",
            "ai_quotation_draft_json",
        }
        assert expected <= cols

    def test_new_rows_default_to_unclassified(self, temp_db, sample_message):
        db.upsert_messages([sample_message])
        message = db.get_message("msg-001")
        assert message["ai_category"] == "Unclassified"
        assert message["ai_party_type"] == "Unknown"
        assert message["ai_security_status"] == "Pending"


class TestUpsert:
    def test_inserts_and_counts(self, temp_db, sample_message):
        assert db.upsert_messages([sample_message]) == 1
        assert db.count_messages() == 1

    def test_round_trips_fields(self, temp_db, sample_message):
        db.upsert_messages([sample_message])
        message = db.get_message("msg-001")
        assert message["subject"] == sample_message["subject"]
        assert message["sender_email"] == "alice@example.com"
        assert message["has_attachments"] == 1

    def test_attachments_and_labels_are_json_encoded(self, temp_db, sample_message):
        db.upsert_messages([sample_message])
        message = db.get_message("msg-001")
        assert message["attachments"][0]["attachment_id"] == "att-1"
        assert "INBOX" in message["label_ids"]

    def test_upsert_updates_instead_of_duplicating(self, temp_db, sample_message):
        db.upsert_messages([sample_message])
        sample_message["subject"] = "Revised subject"
        db.upsert_messages([sample_message])
        assert db.count_messages() == 1
        assert db.get_message("msg-001")["subject"] == "Revised subject"

    def test_upsert_does_not_clobber_classification(self, temp_db, sample_message):
        """Re-syncing known mail must not wipe an existing AI classification."""
        db.upsert_messages([sample_message])
        db.update_message_classification(
            "msg-001",
            {
                "category": "Quotation",
                "party_type": "Customer",
                "security_status": "Safe",
                "confidence": 0.9,
                "reason": "Customer asking for a price",
                "model": "claude",
                "quotation_references": ["MGQ.26/05/111"],
                "quotation_draft": {"customer": "Example Co"},
            },
        )
        db.upsert_messages([{**sample_message, "subject": "Re-synced"}])
        message = db.get_message("msg-001")
        assert message["subject"] == "Re-synced"
        assert message["ai_category"] == "Quotation"
        assert message["ai_confidence"] == 0.9

    def test_message_without_attachments_sets_flag_zero(self, temp_db, sample_message):
        db.upsert_messages([{**sample_message, "attachments": []}])
        assert db.get_message("msg-001")["has_attachments"] == 0


class TestGetAndList:
    def test_get_missing_returns_none(self, temp_db):
        assert db.get_message("nope") is None

    def test_list_messages_respects_limit(self, temp_db, sample_message):
        batch = [{**sample_message, "gmail_message_id": f"msg-{i:03d}"} for i in range(1, 6)]
        db.upsert_messages(batch)
        assert len(db.list_messages(limit=3)) == 3
        assert len(db.list_messages(limit=100)) == 5

    def test_list_messages_is_newest_first(self, temp_db, sample_message):
        db.upsert_messages([{**sample_message, "gmail_message_id": "old", "received_at": "2026-01-01T00:00:00+00:00"}])
        db.upsert_messages([{**sample_message, "gmail_message_id": "new", "received_at": "2026-09-01T00:00:00+00:00"}])
        assert db.list_messages(limit=10)[0]["gmail_message_id"] == "new"

    def test_unclassified_excludes_classified_rows(self, temp_db, sample_message):
        db.upsert_messages(
            [
                {**sample_message, "gmail_message_id": "a"},
                {**sample_message, "gmail_message_id": "b"},
            ]
        )
        db.update_message_classification("a", {"category": "Quotation"})
        pending = {m["gmail_message_id"] for m in db.list_unclassified_messages(limit=10)}
        assert pending == {"b"}


class TestExistingMessageIds:
    def test_returns_only_known_ids(self, temp_db, sample_message):
        db.upsert_messages([sample_message])
        found = db.existing_message_ids(["msg-001", "msg-999", None, ""])
        assert found == {"msg-001"}

    def test_empty_input_short_circuits(self, temp_db):
        assert db.existing_message_ids([]) == set()
        assert db.existing_message_ids([None, ""]) == set()

    def test_handles_more_ids_than_the_sqlite_variable_limit(self, temp_db, sample_message):
        """existing_message_ids chunks at 500; crossing that boundary must not raise."""
        ids = [f"msg-{i:05d}" for i in range(1200)]
        db.upsert_messages([{**sample_message, "gmail_message_id": i} for i in ids[1150:]])
        found = db.existing_message_ids(ids)
        assert len(found) == 50


class TestClassificationUpdates:
    def test_stores_classification_fields(self, temp_db, sample_message):
        db.upsert_messages([sample_message])
        db.update_message_classification(
            "msg-001",
            {
                "category": "Invoice & DO",
                "party_type": "Customer",
                "security_status": "Safe",
                "confidence": 0.75,
                "reason": "PO with a Quote Ref",
                "model": "claude-sonnet-4.5",
                "quotation_references": ["MGQ.26/05/111"],
                "quotation_details": {"customer": "Example Co", "items": []},
                "supplier_reference": "SUP-42",
                "amount": "1200.00",
                "due_date": "2026-10-01",
            },
        )
        message = db.get_message("msg-001")
        assert message["ai_category"] == "Invoice & DO"
        assert message["ai_quotation_references"] == ["MGQ.26/05/111"]
        assert message["ai_quotation_draft"] == {"customer": "Example Co", "items": []}
        assert message["ai_supplier_reference"] == "SUP-42"
        assert message["ai_amount"] == "1200.00"
        assert message["ai_due_date"] == "2026-10-01"
        assert message["ai_model"] == "claude-sonnet-4.5"
        assert message["ai_classified_at"]

    def test_missing_keys_get_safe_defaults(self, temp_db, sample_message):
        """A partial result must not write NULLs into NOT NULL columns."""
        db.upsert_messages([sample_message])
        db.update_message_classification("msg-001", {"category": "Others"})
        message = db.get_message("msg-001")
        assert message["ai_party_type"] == "Unknown"
        assert message["ai_security_status"] == "Suspicious"
        assert message["ai_quotation_references"] == []
        assert message["ai_quotation_draft"] == {}


class TestSetCategory:
    def test_sets_category_and_returns_true(self, temp_db, sample_message):
        db.upsert_messages([sample_message])
        assert db.set_message_category("msg-001", "Supplier Payable") is True
        assert db.get_message("msg-001")["ai_category"] == "Supplier Payable"

    def test_supplier_payable_infers_supplier_party(self, temp_db, sample_message):
        db.upsert_messages([sample_message])
        db.set_message_category("msg-001", "Supplier Payable")
        assert db.get_message("msg-001")["ai_party_type"] == "Supplier"

    def test_missing_message_returns_false(self, temp_db):
        assert db.set_message_category("nope", "Others") is False

    def test_counts_reflect_category(self, temp_db, sample_message):
        db.upsert_messages(
            [
                {**sample_message, "gmail_message_id": "in-1", "label_ids": ["INBOX"]},
                {**sample_message, "gmail_message_id": "pay-1"},
            ]
        )
        db.set_message_category("in-1", "Quotation")
        db.set_message_category("pay-1", "Supplier Payable")
        assert db.count_inbox_messages() == 1
        assert db.count_supplier_payable_messages() == 1
        assert len(db.list_supplier_payable_messages(limit=10)) == 1
