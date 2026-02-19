/**
 * Parses RSS 2.0 and Atom feed XML into a structured object.
 * Returns feed-level metadata (title, description, link) plus an array of items.
 */
export function parseRssFeed(xml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {
    items: [],
  };

  const isAtom: boolean = /<feed[^>]*xmlns=["']http:\/\/www\.w3\.org\/2005\/Atom["']/.test(xml);

  if (isAtom) {
    // For Atom, extract feed-level metadata from outside <entry> blocks
    const feedWithoutEntries: string = xml.replace(/<entry[\s\S]*?<\/entry>/gi, "");

    const atomTitleMatch: RegExpMatchArray | null = feedWithoutEntries.match(/<title[^>]*><!\[CDATA\[(.*?)\]\]><\/title>|<title[^>]*>(.*?)<\/title>/is);
    if (atomTitleMatch) {
      result.title = (atomTitleMatch[1] ?? atomTitleMatch[2] ?? "").trim();
    }

    const atomSubtitleMatch: RegExpMatchArray | null = feedWithoutEntries.match(/<subtitle[^>]*><!\[CDATA\[(.*?)\]\]><\/subtitle>|<subtitle[^>]*>(.*?)<\/subtitle>/is);
    if (atomSubtitleMatch) {
      result.description = (atomSubtitleMatch[1] ?? atomSubtitleMatch[2] ?? "").trim();
    }

    const atomLinkMatch: RegExpMatchArray | null = feedWithoutEntries.match(/<link[^>]*href=["']([^"']+)["'][^>]*(?:\/>|>.*?<\/link>)/is);
    if (atomLinkMatch) {
      result.link = atomLinkMatch[1];
    }

    const entryRegex: RegExp = /<entry[^>]*>([\s\S]*?)<\/entry>/gi;
    const entries: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = entryRegex.exec(xml)) !== null) {
      entries.push(match[1]);
    }

    result.items = entries.map((entry: string): Record<string, unknown> => {
      const item: Record<string, unknown> = {};

      const entryTitleMatch: RegExpMatchArray | null = entry.match(/<title[^>]*><!\[CDATA\[(.*?)\]\]><\/title>|<title[^>]*>(.*?)<\/title>/is);
      if (entryTitleMatch) {
        item.title = (entryTitleMatch[1] ?? entryTitleMatch[2] ?? "").trim();
      }

      const entryLinkMatch: RegExpMatchArray | null = entry.match(/<link[^>]*href=["']([^"']+)["'][^>]*>|<link[^>]*>(.*?)<\/link>/is);
      if (entryLinkMatch) {
        item.link = entryLinkMatch[1] || entryLinkMatch[2];
      }

      const entryContentMatch: RegExpMatchArray | null = entry.match(/<content[^>]*><!\[CDATA\[(.*?)\]\]><\/content>|<content[^>]*>(.*?)<\/content>/is);
      if (entryContentMatch) {
        item.content = entryContentMatch[1] ?? entryContentMatch[2];
      }

      const entrySummaryMatch: RegExpMatchArray | null = entry.match(/<summary[^>]*><!\[CDATA\[(.*?)\]\]><\/summary>|<summary[^>]*>(.*?)<\/summary>/is);
      if (entrySummaryMatch) {
        item.summary = entrySummaryMatch[1] ?? entrySummaryMatch[2];
      }

      const entryIdMatch: RegExpMatchArray | null = entry.match(/<id[^>]*>(.*?)<\/id>/is);
      if (entryIdMatch) {
        item.id = entryIdMatch[1];
      }

      const entryPublishedMatch: RegExpMatchArray | null = entry.match(/<published[^>]*>(.*?)<\/published>|<updated[^>]*>(.*?)<\/updated>/is);
      if (entryPublishedMatch) {
        item.published = entryPublishedMatch[1] ?? entryPublishedMatch[2];
      }

      return item;
    });
  } else {
    // RSS 2.0 — scope feed-level metadata to within the <channel> block
    const channelMatch: RegExpMatchArray | null = xml.match(/<channel[^>]*>([\s\S]*?)<\/channel>/i);
    const channelContent: string = channelMatch ? channelMatch[1] : xml;

    // Strip <item> blocks so feed-level tags don't get confused with item-level ones
    const channelWithoutItems: string = channelContent.replace(/<item[\s\S]*?<\/item>/gi, "");

    const titleMatch: RegExpMatchArray | null = channelWithoutItems.match(/<title[^>]*><!\[CDATA\[(.*?)\]\]><\/title>|<title[^>]*>(.*?)<\/title>/is);
    if (titleMatch) {
      result.title = (titleMatch[1] ?? titleMatch[2] ?? "").trim();
    }

    const descriptionMatch: RegExpMatchArray | null = channelWithoutItems.match(/<description[^>]*><!\[CDATA\[(.*?)\]\]><\/description>|<description[^>]*>(.*?)<\/description>/is);
    if (descriptionMatch) {
      result.description = (descriptionMatch[1] ?? descriptionMatch[2] ?? "").trim();
    }

    // For RSS 2.0, prefer plain <link>...</link> (not atom:link which has href attribute)
    const linkMatch: RegExpMatchArray | null = channelWithoutItems.match(/<link[^>]*>(.*?)<\/link>/is);
    if (linkMatch) {
      result.link = linkMatch[1].trim();
    }

    const itemRegex: RegExp = /<item[^>]*>([\s\S]*?)<\/item>/gi;
    const items: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = itemRegex.exec(channelContent)) !== null) {
      items.push(match[1]);
    }

    result.items = items.map((itemXml: string): Record<string, unknown> => {
      const item: Record<string, unknown> = {};

      const itemTitleMatch: RegExpMatchArray | null = itemXml.match(/<title[^>]*><!\[CDATA\[(.*?)\]\]><\/title>|<title[^>]*>(.*?)<\/title>/is);
      if (itemTitleMatch) {
        item.title = (itemTitleMatch[1] ?? itemTitleMatch[2] ?? "").trim();
      }

      const itemLinkMatch: RegExpMatchArray | null = itemXml.match(/<link[^>]*>(.*?)<\/link>/is);
      if (itemLinkMatch) {
        item.link = itemLinkMatch[1].trim();
      }

      const itemDescMatch: RegExpMatchArray | null = itemXml.match(/<description[^>]*><!\[CDATA\[(.*?)\]\]><\/description>|<description[^>]*>(.*?)<\/description>/is);
      if (itemDescMatch) {
        item.description = itemDescMatch[1] ?? itemDescMatch[2];
      }

      const itemGuidMatch: RegExpMatchArray | null = itemXml.match(/<guid[^>]*>(.*?)<\/guid>/is);
      if (itemGuidMatch) {
        item.guid = itemGuidMatch[1];
      }

      const itemPubDateMatch: RegExpMatchArray | null = itemXml.match(/<pubDate[^>]*>(.*?)<\/pubDate>/is);
      if (itemPubDateMatch) {
        item.pubDate = itemPubDateMatch[1];
      }

      return item;
    });
  }

  return result;
}
