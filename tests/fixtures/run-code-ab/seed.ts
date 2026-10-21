/**
 * Phase 2 A/B harness — deterministic seed data (plan §2.1).
 *
 * All rows are pure functions of the row index: NO Math.random / Date.now, so
 * every run seeds byte-identical data. Column types are INTEGER/TEXT/REAL only
 * and no column name is date-like (created/updated/timestamp) — otherwise the
 * write tool auto-fills timestamps (per-table-tools.ts) and breaks exact-match
 * assertions.
 */

import * as litesql from "../../../src/helpers/litesql.js";

export const DB_NAME: string = "blackdog";

//#region Row types

export interface IRssRow {
  id: number;
  title: string;
  link: string;
  pub_date: string;
  description: string;
}

export interface IContactRow {
  id: number;
  name: string;
  email: string;
  country: string;
  status: string;
  discount: number;
  notes: string;
}

export interface IOrderRow {
  id: number;
  customer: string;
  product: string;
  qty: number;
  price: number;
  order_date: string;
}

//#endregion Row types

//#region Deterministic vocabularies (fixed literals — byte-identical every run)

const RSS_TITLE_TOPICS: string[] = [
  "Harbor towns expand night ferry routes",
  "Orchard yields climb after mild spring",
  "River basin council approves new crossings",
  "Mountain observatory opens public nights",
  "Coastal markets report record grain sales",
  "Forest rangers map ancient trail network",
  "Desert solar farms double output again",
  "Island libraries launch book boat service",
  "Valley schools adopt garden curriculum",
  "Northern rail link finishes ahead of plan",
  "Lakeside clinics extend weekend hours",
  "Old town walls get evening light trail",
  "Highland shepherds trial drone herding",
  "City archives digitize century of maps",
  "Delta wetlands welcome rare bird flocks",
];

/** Fixed id set whose titles carry the exact token QUANTUM (plan §2.1). */
export const QUANTUM_IDS: ReadonlySet<number> = new Set([2, 5, 9, 12, 14]);

const CONTACT_NAMES: string[] = [
  "Ada Novak", "Boris Feld", "Cleo Marsh", "Dario Venn", "Elsa Brandt",
  "Felix Okafor", "Greta Lindqvist", "Hugo Ferreira", "Iris Kovac", "Jonas Weber",
  "Kira Tanaka", "Liam O'Connor", "Mira Petrov", "Nils Andersen", "Ola Jensen",
  "Petra Horvat", "Quinn Bailey", "Rosa Marino", "Stefan Kruger", "Tara Singh",
  "Ulf Bergstrom", "Vera Dvorak", "Wim Bakker", "Xenia Rossi", "Yusuf Demir",
  "Zara Ahmed", "Anton Silveira", "Bea Fontaine", "Cyril Novak", "Dora Lindgren",
];

const CONTACT_COUNTRIES: string[] = ["US", "DE", "FR", "CZ", "BR", "IN", "JP", "SE"];

const ORDER_CUSTOMERS: string[] = [
  "Acme Trading", "Blue Harbor Ltd", "Cedar Works", "Delta Supply Co",
  "Elm Street Goods", "Frostline Inc", "Granite Partners", "Harbor Light LLC",
];

const ORDER_PRODUCTS: string[] = [
  "oak dining table", "steel water bottle", "wool throw blanket",
  "ceramic planter set", "leather weekender bag", "brass desk lamp",
  "linen duvet cover", "walnut bookshelf",
];

const FILLER: string =
  "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ";

/** Deterministic filler: fixed template + index-derived repetition. */
function fillerFor(index: number, targetChars: number): string {
  const seed: string = `digest-${index} ${FILLER}`;
  let out: string = "";
  while (out.length < targetChars) {
    out += seed;
  }
  return out.slice(0, targetChars);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

//#endregion Deterministic vocabularies

//#region Row builders (pure functions of the 1-based row index)

export function buildRssRow(i: number): IRssRow {
  const topic: string = RSS_TITLE_TOPICS[(i - 1) % RSS_TITLE_TOPICS.length];
  const title: string = QUANTUM_IDS.has(i) ? `QUANTUM breakthrough: ${topic}` : topic;
  return {
    id: i,
    title,
    link: `https://example.com/feed/item-${pad2(i)}`,
    pub_date: `2026-09-01T${pad2(8 + ((i - 1) % 10))}:00:00Z`,
    description: fillerFor(i, 140),
  };
}

export function buildContactRow(i: number): IContactRow {
  const name: string = CONTACT_NAMES[(i - 1) % CONTACT_NAMES.length];
  const emailLocal: string = name.toLowerCase().replace(/[^a-z]+/g, ".").replace(/^\.|\.$/g, "");
  return {
    id: i,
    name,
    email: `${emailLocal}${i}@example.com`,
    country: CONTACT_COUNTRIES[(i - 1) % CONTACT_COUNTRIES.length],
    status: i % 3 === 0 ? "inactive" : "active",
    discount: 5 + ((i * 7) % 21),
    notes: fillerFor(i + 1000, 90),
  };
}

export function buildOrderRow(i: number): IOrderRow {
  return {
    id: i,
    customer: ORDER_CUSTOMERS[(i - 1) % ORDER_CUSTOMERS.length],
    product: ORDER_PRODUCTS[(i - 1) % ORDER_PRODUCTS.length],
    qty: 1 + ((i * 3) % 9),
    price: Math.round((9.99 + ((i * 13) % 4000) / 100) * 100) / 100,
    order_date: `2026-08-${pad2(1 + ((i - 1) % 28))}T10:30:00Z`,
  };
}

//#endregion Row builders

//#region DDL

const RSS_COLUMNS = [
  { name: "id", type: "INTEGER", primaryKey: true, notNull: true },
  { name: "title", type: "TEXT", notNull: true },
  { name: "link", type: "TEXT", notNull: true },
  { name: "pub_date", type: "TEXT", notNull: true },
  { name: "description", type: "TEXT", notNull: true },
];

const CONTACT_COLUMNS = [
  { name: "id", type: "INTEGER", primaryKey: true, notNull: true },
  { name: "name", type: "TEXT", notNull: true },
  { name: "email", type: "TEXT", notNull: true },
  { name: "country", type: "TEXT", notNull: true },
  { name: "status", type: "TEXT", notNull: true },
  { name: "discount", type: "INTEGER", notNull: true },
  { name: "notes", type: "TEXT", notNull: true },
];

const ORDER_COLUMNS = [
  { name: "id", type: "INTEGER", primaryKey: true, notNull: true },
  { name: "customer", type: "TEXT", notNull: true },
  { name: "product", type: "TEXT", notNull: true },
  { name: "qty", type: "INTEGER", notNull: true },
  { name: "price", type: "REAL", notNull: true },
  { name: "order_date", type: "TEXT", notNull: true },
];

/**
 * Seeds the tables for one task (src + dst, dst empty) BEFORE the agent build,
 * so per-table write tools are discovered at build time (plan §2.1).
 */
export async function seedTaskAsync(task: number): Promise<void> {
  await litesql.ensureDatabaseExists(DB_NAME);
  if (task === 1) {
    await createSeededAsync("rss_inbox", RSS_COLUMNS, rowsFor(15, buildRssRow));
    await createEmptyAsync("news", RSS_COLUMNS);
  } else if (task === 2) {
    await createSeededAsync("rss_inbox", RSS_COLUMNS, rowsFor(15, buildRssRow));
    await createEmptyAsync("news_filtered", RSS_COLUMNS);
  } else if (task === 3) {
    await createSeededAsync("crm_contacts", CONTACT_COLUMNS, rowsFor(30, buildContactRow));
  } else if (task === 4) {
    await createSeededAsync("legacy_orders", ORDER_COLUMNS, rowsFor(40, buildOrderRow));
    await createEmptyAsync("orders_v2", ORDER_COLUMNS);
  } else {
    throw new Error(`seedTaskAsync: unknown task ${task}`);
  }
}

function rowsFor<T>(count: number, build: (i: number) => T): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let i: number = 1; i <= count; i++) {
    out.push(build(i) as unknown as Record<string, unknown>);
  }
  return out;
}

async function createSeededAsync(
  table: string,
  columns: { name: string; type: string; primaryKey?: boolean; notNull?: boolean }[],
  rows: Record<string, unknown>[],
): Promise<void> {
  await litesql.createTableAsync(DB_NAME, table, columns);
  await litesql.insertIntoTableAsync(DB_NAME, table, rows as Record<string, unknown>[]);
}

async function createEmptyAsync(
  table: string,
  columns: { name: string; type: string; primaryKey?: boolean; notNull?: boolean }[],
): Promise<void> {
  await litesql.createTableAsync(DB_NAME, table, columns);
}

//#endregion DDL
