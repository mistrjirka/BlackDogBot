import { IColumnInfo, ITableInfo } from "../services/litesql.service.js";

//#region Interfaces

export interface IJsonSchema {
  type: "object";
  properties: Record<string, IJsonSchemaProperty>;
  required: string[];
}

export interface IJsonSchemaProperty {
  type: string;
  format?: string;
  description?: string;
}

//#endregion Interfaces

//#region Public functions

/**
 * Converts SQLite column definitions to a JSON Schema suitable for INSERT operations.
 * - INTEGER → { type: "integer" }
 * - TEXT → { type: "string" }
 * - REAL → { type: "number" }
 * - BLOB → { type: "string", format: "binary" }
 * - Primary key columns are excluded from required (auto-generated)
 */
export function columnsToJsonSchema(columns: IColumnInfo[]): IJsonSchema {
  const properties: Record<string, IJsonSchemaProperty> = {};
  const required: string[] = [];

  for (const col of columns) {
    // Skip primary key columns — they are auto-generated
    if (col.primaryKey) {
      continue;
    }

    properties[col.name] = _sqlTypeToJsonSchemaProperty(col.type);

    if (col.notNull && col.defaultValue === null) {
      required.push(col.name);
    }
  }

  return {
    type: "object",
    properties,
    required,
  };
}

/**
 * Derives a JSON Schema from an existing table using its full schema info.
 * Convenience wrapper around columnsToJsonSchema.
 */
export function deriveInputSchemaFromTable(tableInfo: ITableInfo): IJsonSchema {
  return columnsToJsonSchema(tableInfo.columns);
}

/**
 * Validates that a provided inputSchemaHint is broadly compatible with the actual
 * table columns. Returns a list of warning strings (empty = no issues).
 *
 * Checks:
 * - All required columns in the actual table schema appear in the hint properties
 * - Does not fail on extra columns in the hint
 */
export function validateSchemaHintAgainstTable(
  hint: Record<string, unknown>,
  tableInfo: ITableInfo,
): string[] {
  const warnings: string[] = [];
  const actualSchema: IJsonSchema = columnsToJsonSchema(tableInfo.columns);

  const hintProperties: Record<string, unknown> = (hint.properties ?? {}) as Record<string, unknown>;

  const missingRequired: string[] = actualSchema.required.filter(
    (col: string) => !(col in hintProperties),
  );

  if (missingRequired.length > 0) {
    warnings.push(
      `Schema mismatch detected. Missing required columns: ${missingRequired.join(", ")}. ` +
        `These columns are NOT NULL in the table but absent from inputSchemaHint.`,
    );
  }

  return warnings;
}

//#endregion Public functions

//#region Private functions

function _sqlTypeToJsonSchemaProperty(sqlType: string): IJsonSchemaProperty {
  const upperType: string = sqlType.toUpperCase().trim();

  if (upperType === "INTEGER" || upperType === "INT") {
    return { type: "integer" };
  }

  if (upperType === "REAL" || upperType === "FLOAT" || upperType === "DOUBLE") {
    return { type: "number" };
  }

  if (upperType === "BLOB") {
    return { type: "string", format: "binary" };
  }

  // TEXT and anything else defaults to string
  return { type: "string" };
}

//#endregion Private functions
