//#region Interfaces

export interface IBuildNoveltyPromptInput {
  taskContextBlock: string;
  candidateMessage: string;
  similarMessagesBlock: string;
}

export interface ISearchResultMetadata {
  sentAt?: string;
  taskId?: string;
}

//#endregion Interfaces

//#region Public Functions

export function buildCronNoveltyPrompt(input: IBuildNoveltyPromptInput): string {
  return `You are a strict deduplication checker for cron notifications.

Your job: determine whether the CANDIDATE MESSAGE describes a genuinely NEW EVENT that users have not already been notified about.

RULES:
- If the candidate and any previous message describe the SAME CORE EVENT, classify as DUPLICATE (isNewInformation=false).
- "Same core event" means same real-world incident/alert subject, even if the candidate adds new context, extra details, statistics, or stronger wording.
- Added details about an already-known event are NOT new information.
- Rephrasing, different tone, reordered wording, timestamp formatting, or style changes are NOT new information.
- Status/progress chatter ("task done", "fetched X", "processing complete") is NOT new information unless task instructions explicitly require those updates.
- Only classify as NEW when the core event itself is different (different incident/entity/location/outcome), not just richer description of the same incident.
- When uncertain, choose isNewInformation=false.

CORE EVENT TEST (must be applied first):
1) Identify the core event in the candidate.
2) Check whether that same core event appears in any previous message.
3) If yes, isNewInformation MUST be false.
4) Only if core event is absent from all previous messages may isNewInformation be true.

EXAMPLE A (duplicate -> false):
Candidate: "ENERGY ALERT: Trump threatens Iranian power plants; US weighs Kharg Island seizure"
Previous:  "ENERGY ALERT: Trump's ultimatum threatens Iranian power infrastructure; US considers seizing Kharg Island"
Reason: same core event, different wording.

EXAMPLE B (duplicate -> false):
Candidate: "ENERGY ALERT: Czech factory arson verified; IEA says crisis worse than 1970s"
Previous:  "ENERGY ALERT: Czech thermal imaging factory arson attack confirmed"
Reason: same core event (Czech factory arson). Added IEA context does not create a new event.

EXAMPLE C (new -> true):
Candidate: "ENERGY ALERT: Slovenia starts fuel rationing at 50L/day"
Previous:  "ENERGY ALERT: Trump threatens Iranian power plants; Kharg Island risk"
Reason: different core event.

OUTPUT REQUIREMENTS:
1) In \`reasoning\`, explicitly state the candidate core event and whether it already exists in previous messages (cite the matching rank numbers when applicable).
2) If core event already exists, isNewInformation MUST be false.
3) Only mark true if the candidate core event is genuinely different.

${input.taskContextBlock}

Candidate message:
${input.candidateMessage}

Top similar previous messages:
${input.similarMessagesBlock}`;
}

export function buildCronDispatchPolicyPrompt(input: {
  taskInstructions: string;
  taskName?: string;
  taskDescription?: string;
  candidateMessage: string;
}): string {
  return `You are a strict cron notification policy checker.

Decide whether the candidate message should be dispatched to the user based on task instructions.

Rule: If task instructions indicate silent/background execution or say not to send status/progress updates, then status/progress messages must NOT be dispatched.

Allow dispatch only when at least one is true:
1) Task instructions explicitly require sending this kind of update, or
2) Candidate message contains a critical error/warning requiring user action, or
3) Candidate message is the requested final deliverable/output.

Status/progress messages include: "task complete", "fetched X", "processed Y", "stored records", "silent operation complete", and similar operational summaries.

If unsure, prefer shouldDispatch=false.

EXAMPLE A (dispatch=false):
Task instructions: "Run silently. Send only critical alerts."
Candidate: "Task complete: fetched 16 articles, stored in DB."
Reason: routine status update, not a critical alert, must be suppressed.

EXAMPLE B (dispatch=true):
Task instructions: "Run silently. Send only critical alerts."
Candidate: "ENERGY ALERT: Strait disruption now impacting Czechia-relevant supply routes."
Reason: this is a critical alert class explicitly allowed by instructions.

OUTPUT REQUIREMENTS:
1) In \`reasoning\`, cite which instruction lines allow or forbid this message type.
2) Decide shouldDispatch accordingly.

Task context:
taskName: ${input.taskName ?? "unknown"}
taskDescription: ${input.taskDescription ?? ""}
taskInstructions:
${input.taskInstructions}

Candidate message:
${input.candidateMessage}`;
}

export function parseSearchMetadata(rawMetadata: string): ISearchResultMetadata {
  try {
    return JSON.parse(rawMetadata) as ISearchResultMetadata;
  } catch {
    return {};
  }
}

export function buildSearchPreview(content: string, previewLength: number): string {
  const normalized: string = content.replace(/\s+/g, " ").trim();

  if (normalized.length <= previewLength) {
    return normalized;
  }

  return `${normalized.slice(0, previewLength)}...`;
}

//#endregion Public Functions
