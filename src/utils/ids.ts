import { createHash, randomUUID } from "node:crypto";

export function stableId(prefix: string, parts: Array<string | undefined>): string {
  const normalized = parts
    .filter((part): part is string => Boolean(part))
    .map((part) => part.trim().toLowerCase().replace(/\s+/g, " "))
    .join("\n");

  if (!normalized) {
    return `${prefix}:${randomUUID()}`;
  }

  return `${prefix}:${createHash("sha256").update(normalized).digest("hex").slice(0, 16)}`;
}

export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return slug || randomUUID();
}
