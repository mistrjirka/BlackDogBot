import { z } from "zod";

//#region RSS Schemas

export const rssStateSchema = z.object({
  feedUrl: z.string(),
  seenIds: z.string()
    .array(),
  lastFetchedAt: z.string(),
});

//#endregion RSS Schemas
