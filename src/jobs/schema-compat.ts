import { Ajv, type ValidateFunction } from "ajv";

//#region Interfaces

export interface ISchemaCompatResult {
  compatible: boolean;
  errors: string[];
}

export interface ICheckSchemaCompatOptions {
  /** In strict mode, schemas without a 'type' property on required fields also produce errors. */
  strictMode?: boolean;
}

//#endregion Interfaces

//#region Constants

const _Ajv: Ajv = new Ajv({ allErrors: true, strict: false });

//#endregion Constants

//#region Public functions

export function checkSchemaCompatibility(
  outputSchema: Record<string, unknown>,
  inputSchema: Record<string, unknown>,
  options?: ICheckSchemaCompatOptions,
): ISchemaCompatResult {
  const errors: string[] = [];
  const strictMode: boolean = options?.strictMode ?? false;

  // If either schema is empty or trivial, consider compatible
  if (!outputSchema || !inputSchema) {
    return { compatible: true, errors: [] };
  }

  // In strict mode, schemas with no 'type' (i.e., empty {}) are NOT automatically compatible
  if (strictMode) {
    if (!outputSchema.type && Object.keys(outputSchema).length === 0) {
      errors.push(`Output schema is empty ({}). In strict mode, a typed schema is required.`);
    }

    if (!inputSchema.type && Object.keys(inputSchema).length === 0) {
      errors.push(`Input schema is empty ({}). In strict mode, a typed schema is required.`);
    }

    if (errors.length > 0) {
      return { compatible: false, errors };
    }
  }

  const outputProps: Record<string, unknown> = (outputSchema.properties ?? {}) as Record<string, unknown>;
  const inputProps: Record<string, unknown> = (inputSchema.properties ?? {}) as Record<string, unknown>;
  const requiredInputs: string[] = (inputSchema.required ?? []) as string[];

  // Check that all required input fields exist in the output
  for (const requiredField of requiredInputs) {
    if (!(requiredField in outputProps)) {
      errors.push(`Required input field "${requiredField}" is missing from the output schema.`);
    }
  }

  // Check type compatibility for overlapping fields
  for (const fieldName of Object.keys(inputProps)) {
    if (fieldName in outputProps) {
      const inputField = inputProps[fieldName] as Record<string, unknown> | undefined;
      const outputField = outputProps[fieldName] as Record<string, unknown> | undefined;

      if (inputField && outputField) {
        if (strictMode && !inputField.type) {
          errors.push(`Field "${fieldName}" in input schema is missing a 'type' property.`);
        }

        if (inputField.type && outputField.type) {
          if (inputField.type !== outputField.type) {
            errors.push(
              `Field "${fieldName}" type mismatch: output is "${String(outputField.type)}" but input expects "${String(inputField.type)}".`,
            );
          }

          // For array types, also check items schema compatibility
          if (inputField.type === "array" && outputField.type === "array") {
            const inputItems = inputField.items as Record<string, unknown> | undefined;
            const outputItems = outputField.items as Record<string, unknown> | undefined;

            if (inputItems && outputItems) {
              const itemsResult: ISchemaCompatResult = checkSchemaCompatibility(
                outputItems,
                inputItems,
                options,
              );

              for (const itemErr of itemsResult.errors) {
                errors.push(`Field "${fieldName}[].${itemErr}`);
              }
            }
          }
        }
      }
    }
  }

  return {
    compatible: errors.length === 0,
    errors,
  };
}

export function validateDataAgainstSchema(
  data: Record<string, unknown>,
  schema: Record<string, unknown>,
): ISchemaCompatResult {
  const errors: string[] = [];

  if (!schema || Object.keys(schema).length === 0) {
    return { compatible: true, errors: [] };
  }

  try {
    const validate: ValidateFunction = _Ajv.compile(schema);
    const valid: boolean = validate(data) as boolean;

    if (!valid && validate.errors) {
      for (const err of validate.errors) {
        errors.push(`${err.instancePath || "/"}: ${err.message ?? "unknown validation error"}`);
      }
    }
  } catch (error: unknown) {
    errors.push(`Schema compilation failed: ${(error as Error).message}`);
  }

  return {
    compatible: errors.length === 0,
    errors,
  };
}

//#endregion Public functions
