# v34 – Scope validation and forced re-extraction

- Quotation extraction version bumped to 4 so old cached v33 drafts are reprocessed.
- AI descriptions that look like copied email bodies are rejected.
- When AI returns an email dump, the backend rebuilds concise rows from Scope of Work/action verbs.
- Inbox View now checks extraction version, not merely whether an items array exists.
- Browser fallbacks no longer copy the whole email body into the quotation Description.
- Human-edited quotation drafts remain protected from automation overwrite.
