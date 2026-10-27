---
name: web-research
description: Research changing or uncertain facts on the public web; verify technical claims, versions, compatibility, provenance, and contradictory evidence before answering. Use for multi-source research, unfamiliar technical topics, or important claims about functionality and safety.
userInvocable: true
disableModelInvocation: false
---

# Evidence-grounded web research

Use connected search/browser tools following the tool-routing instructions. This skill governs **evidence interpretation**, not browser selection. Do not launch a separate agent, install tools, or do exhaustive research for simple questions.

## Plan the question

Identify what the user actually needs to decide, including relevant platform/product, version, time, geography, and what terms mean. Distinguish **what works**, **how it is triggered**, **whether it survives reboot**, and **whether files survive reboot**: these are not interchangeable.

## Gather sources economically

1. Discover with search; read the actual primary documentation or authoritative original source where feasible. Search snippets are only leads and cannot establish a claim by themselves. Prioritize authors' documentation, official support matrices, and reputable independent confirmation over SEO articles or unverifiable social posts.
2. Preserve the source URL, publisher, available publication/update date, and exact supporting passage. `run_code` may extract a paragraph, but an extraction is only evidence when tied to the original retrieved page. For large pages prefer short relevant passages with nearby qualifiers.
3. A 403, 404, challenge page, snippet, or unvisited link is not a successfully read source. Do not cite it as if consulted. After repeated domain failures switch source, and disclose relevant limitations.
4. Stop when enough good evidence answers the question; do not chase irrelevant results or keep rereading the same text.

## Check each important conclusion

For a non-obvious or high-impact technical conclusion, write a brief internal claim-to-evidence mapping: **claim → exact passage → original URL → product/platform/version → directly supported, inference, conflicting, or unknown**. Compare claim *predicates*, not just shared keywords. "Auto-run after inserting a disc" DOES NOT entail "persists after a full shutdown"; documentation for PS5 does not imply PS4 compatibility. A userland entrypoint, a kernel exploit and a payload are different components.

Use `verify_claim_evidence` when available for consequential, surprising, disputed, version-dependent or multi-product claims **when source material is retained in a blackboard variable**. Provide exact quotations and the applicable platform. The tool checks whether a quote exists and catches simple platform mismatches; it does **not** establish semantic entailment or truth. If the returned verdict is `scope_mismatch` or the passage is missing, correct the claim or mark it unverified. If the quote exists, you must still decide whether it **actually proves** the asserted fact. When practical, seek independent confirmation for extraordinary claims, rather than relying on one SEO article.

If the source has opposing evidence, explicitly reconcile it or report unresolved disagreement. Never fill a gap using prior assumptions and then cite an unrelated passage as support.

## Answer

Separate verified facts from inference and unresolved uncertainty. Only cite URLs whose text was actually retrieved; never elevate a snippet or a failed navigation to a verified source. Say when a particular claim could not be substantiated. For ordinary straightforward information, be concise and omit the evidence ledger from the final reply unless useful.
