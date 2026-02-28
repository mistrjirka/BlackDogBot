/**
 * Parses RSS 2.0 and Atom feed XML into a structured object.
 * Returns feed-level metadata (title, description, link) plus an array of items.
 * Extracts ALL available fields from each item including content:encoded.
 */

function extractAllTags(xml: string): Record<string, string> {
  const result: Record<string, string> = {};
  
  // Match any tag with its content
  const tagRegex = /<([a-zA-Z0-9_:]+)[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  
  while ((match = tagRegex.exec(xml)) !== null) {
    const tagName = match[1];
    let content = match[2];
    
    // Handle CDATA
    const cdataMatch = content.match(/<!\[CDATA\[(.*?)\]\]>/is);
    if (cdataMatch) {
      content = cdataMatch[1];
    }
    
    result[tagName] = content.trim();
  }
  
  return result;
}

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
      return extractAllTags(entry);
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

    // Extract ALL tags from each item
    result.items = items.map((itemXml: string): Record<string, unknown> => {
      return extractAllTags(itemXml);
    });
  }

  return result;
}
