# v30 – AI Gateway Resilience

This patch prevents a temporary Claude gateway error from blocking the human review workflow.

- A quotation can still be opened and edited if AI preparation fails.
- The fallback draft uses the real Gmail subject/body and leaves unsupported fields blank.
- Repeated View clicks no longer create a burst of repeated classification requests.
- Failed preparation is throttled for 60 seconds in the browser session.
- The backend logs the actual classification exception and returns a clearer 502 detail.
- The LLM client retries once with the system instructions folded into the user message for gateways that reject `system` roles.
