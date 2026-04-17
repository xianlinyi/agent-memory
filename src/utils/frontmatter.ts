export interface MarkdownDocument {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseMarkdownDocument(markdown: string): MarkdownDocument {
  if (!markdown.startsWith("---\n")) {
    return { frontmatter: {}, body: markdown };
  }

  const end = markdown.indexOf("\n---", 4);
  if (end === -1) {
    return { frontmatter: {}, body: markdown };
  }

  const raw = markdown.slice(4, end);
  const body = markdown.slice(end + 4).replace(/^\n/, "");
  return { frontmatter: parseSimpleYaml(raw), body };
}

export function stringifyMarkdownDocument(document: MarkdownDocument): string {
  return `---\n${stringifySimpleYaml(document.frontmatter)}---\n\n${document.body.trim()}\n`;
}

function parseSimpleYaml(raw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = raw.split(/\r?\n/);
  let currentKey: string | undefined;

  for (const line of lines) {
    if (!line.trim()) continue;

    const listMatch = /^  - (.*)$/.exec(line);
    if (listMatch && currentKey) {
      const existing = result[currentKey];
      const list = Array.isArray(existing) ? existing : [];
      list.push(parseScalar(listMatch[1]));
      result[currentKey] = list;
      continue;
    }

    const keyMatch = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line);
    if (!keyMatch) continue;

    currentKey = keyMatch[1];
    const value = keyMatch[2] ?? "";
    result[currentKey] = value === "" ? [] : parseScalar(value);
  }

  return result;
}

function stringifySimpleYaml(data: Record<string, unknown>): string {
  return Object.entries(data)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      if (Array.isArray(value)) {
        if (value.length === 0) return `${key}: []\n`;
        return `${key}:\n${value.map((item) => `  - ${formatScalar(item)}`).join("\n")}\n`;
      }

      if (value && typeof value === "object") {
        return `${key}: ${JSON.stringify(value)}\n`;
      }

      return `${key}: ${formatScalar(value)}\n`;
    })
    .join("");
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "[]") return [];
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function formatScalar(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = String(value ?? "");
  if (!text || /[:#\n\r]|^\s|\s$/.test(text)) {
    return JSON.stringify(text);
  }
  return text;
}
