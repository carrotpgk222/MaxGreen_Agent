"""Tests for the AI-output normalisers.

These are the boundary that keeps hostile or sloppy model output out of the database,
so the fallbacks matter more than the happy path.
"""

from __future__ import annotations

import pytest

from services import classification_service as cs


class TestNormalizeCategory:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("Quotation", "Quotation"),
            ("Invoice & DO", "Invoice & DO"),
            ("Supplier Payable", "Supplier Payable"),
            ("Others", "Others"),
            # documented aliases
            ("Other", "Others"),
            ("Supplier payable", "Supplier Payable"),
            ("Invoice & Delivery Order", "Invoice & DO"),
        ],
    )
    def test_known_values_and_aliases(self, raw, expected):
        assert cs._normalize_category(raw) == expected

    @pytest.mark.parametrize("raw", ["", None, "Nonsense", "quotation", 42, {"a": 1}])
    def test_unknown_falls_back_to_others(self, raw):
        assert cs._normalize_category(raw) == "Others"

    def test_result_is_always_in_the_allowed_set(self):
        for raw in ["Whatever", "", None, "Quotation"]:
            assert cs._normalize_category(raw) in cs.VALID_CATEGORIES


class TestNormalizeParty:
    @pytest.mark.parametrize("raw", ["Customer", "Supplier", "Unknown"])
    def test_known_values_pass_through(self, raw):
        assert cs._normalize_party(raw) == raw

    @pytest.mark.parametrize("raw", ["", None, "customer", "Vendor", 7])
    def test_unknown_falls_back_to_unknown(self, raw):
        assert cs._normalize_party(raw) == "Unknown"


class TestNormalizeSecurity:
    @pytest.mark.parametrize("raw", ["Safe", "Spam", "Prompt Injection", "Suspicious"])
    def test_known_values_pass_through(self, raw):
        assert cs._normalize_security(raw) == raw

    @pytest.mark.parametrize("raw", ["", None, "safe", "Definitely Fine", []])
    def test_unknown_falls_back_to_suspicious(self, raw):
        """Fail closed: an unrecognised verdict must not be treated as Safe."""
        assert cs._normalize_security(raw) == "Suspicious"

    def test_never_normalises_to_safe_by_accident(self):
        assert cs._normalize_security("SAFE ") == "Suspicious"
        assert cs._normalize_security("safe") == "Suspicious"


class TestNormalizeConfidence:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [(0.0, 0.0), (1.0, 1.0), (0.5, 0.5), ("0.75", 0.75), (2, 1.0), (-1, 0.0), (900, 1.0)],
    )
    def test_clamps_to_unit_interval(self, raw, expected):
        assert cs._normalize_confidence(raw) == pytest.approx(expected)

    @pytest.mark.parametrize("raw", ["high", None, "", []])
    def test_non_numeric_becomes_zero(self, raw):
        assert cs._normalize_confidence(raw) == 0.0


class TestCleanQuoteRef:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("MGQ.26/05/111", "MGQ.26/05/111"),
            ("  MGQ.26/05/111  ", "MGQ.26/05/111"),
            ("MGQ.26/05/111]", "MGQ.26/05/111"),
            ("MGQ.26/05/111,", "MGQ.26/05/111"),
            ("MGQ.26/05/111;", "MGQ.26/05/111"),
            ("MGQ.26/05/111)", "MGQ.26/05/111"),
            ("", ""),
            (None, ""),
        ],
    )
    def test_strips_trailing_punctuation(self, raw, expected):
        assert cs._clean_quote_ref(raw) == expected

    def test_trailing_dot_is_kept_but_is_harmless_downstream(self):
        """A ref at the end of a sentence keeps its period.

        The pattern's character class swallows the `.`, and `_clean_quote_ref` deliberately
        does not strip it. That is cosmetically imperfect in stored text, but matching is
        unaffected: `normalizeRef()` in frontend/assets/js/core/gmailWorkflowBridge.js strips
        every non-alphanumeric character, so "MGQ.26/05/111." and "MGQ.26/05/111" both
        reduce to "MGQ2605111".
        """
        assert cs._clean_quote_ref("MGQ.26/05/111.") == "MGQ.26/05/111."
        refs = cs._deterministic_quote_refs({"body_text": "Quote Ref: MGQ.26/05/111. Thanks."}, [])
        assert refs == ["MGQ.26/05/111."]


class TestDeterministicQuoteRefs:
    def test_finds_ref_in_body_text(self, sample_message):
        refs = cs._deterministic_quote_refs(sample_message, [])
        assert refs == ["MGQ.26/05/111"]

    def test_finds_ref_in_attachment_text(self, sample_message):
        sample_message["body_text"] = "No reference here."
        attachments = [{"text": "Quote Ref: MGQ.26/05/222"}]
        assert cs._deterministic_quote_refs(sample_message, attachments) == ["MGQ.26/05/222"]

    def test_deduplicates_case_insensitively_keeping_first(self, sample_message):
        sample_message["body_text"] = "Quote Ref: MGQ.26/05/111 and again quote ref: mgq.26/05/111"
        refs = cs._deterministic_quote_refs(sample_message, [])
        assert refs == ["MGQ.26/05/111"]

    def test_multiple_distinct_refs_are_all_returned(self, sample_message):
        sample_message["body_text"] = "Quote Ref: MGQ.26/05/111 and Quote Ref: MGQ.26/05/222"
        assert cs._deterministic_quote_refs(sample_message, []) == ["MGQ.26/05/111", "MGQ.26/05/222"]

    @pytest.mark.parametrize("body", ["", None, "Quote Ref: not-a-maxon-ref", "no match here"])
    def test_returns_empty_when_nothing_matches(self, body):
        assert cs._deterministic_quote_refs({"body_text": body, "snippet": ""}, []) == []

    def test_survives_a_message_with_no_fields(self):
        assert cs._deterministic_quote_refs({}, []) == []


class TestCleanScopeLine:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("Replace  3   filters", "Replace 3 filters"),
            ("  Clean the lobby  ", "Clean the lobby"),
            ("- Clean the lobby", "Clean the lobby"),
            ("1. Supply 2 units", "Supply 2 units"),
            ("2) Paint walls", "Paint walls"),
            ("• Inspect roof", "Inspect roof"),
            ("", ""),
            (None, ""),
        ],
    )
    def test_collapses_whitespace_and_strips_bullets(self, raw, expected):
        """Every whitespace run collapses to a single space, including internal ones."""
        assert cs._clean_scope_line(raw) == expected


class TestHeuristicScopeItems:
    def test_extracts_lines_under_a_scope_heading(self, sample_message):
        sample_message["body_text"] = "Hi,\nScope of Work:\n- Replace 3 filters\n- Clean the lobby\nThanks"
        items = cs._heuristic_scope_items(sample_message)
        descriptions = [item.get("description", "") for item in items]
        assert any("Replace 3 filters" in d for d in descriptions)

    def test_empty_body_yields_nothing(self, sample_message):
        assert cs._heuristic_scope_items({"body_text": "", "snippet": ""}) == []
