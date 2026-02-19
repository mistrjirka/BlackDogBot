import { nanoid } from "nanoid";

const _DefaultIdLength: number = 12;

export function generateId(length: number = _DefaultIdLength): string {
  return nanoid(length);
}
