export function inferCodeLanguageFromPath(filePath: string): string {
  const normalized = filePath.trim().toLowerCase();
  const fileName = normalized.split("/").filter(Boolean).pop() ?? normalized;

  const exactMatch = EXACT_LANGUAGE_BY_FILE_NAME[fileName];
  if (exactMatch) return exactMatch;

  const extension = fileName.includes(".")
    ? fileName.slice(fileName.lastIndexOf("."))
    : "";
  return LANGUAGE_BY_EXTENSION[extension] ?? "text";
}

export function shouldRenderMarkdownPreview(filePath: string): boolean {
  const normalized = filePath.trim().toLowerCase();
  if (normalized.endsWith(".mdx")) return false;
  return normalized.endsWith(".md")
    || normalized.endsWith(".markdown")
    || normalized.endsWith(".mdown")
    || normalized.endsWith(".mkd");
}

const EXACT_LANGUAGE_BY_FILE_NAME: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "make",
  justfile: "make",
  ".gitignore": "gitignore",
  ".env": "dotenv",
};

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".bash": "bash",
  ".c": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cjs": "javascript",
  ".conf": "ini",
  ".css": "css",
  ".go": "go",
  ".h": "c",
  ".hpp": "cpp",
  ".html": "html",
  ".ini": "ini",
  ".java": "java",
  ".js": "javascript",
  ".json": "json",
  ".jsx": "jsx",
  ".mjs": "javascript",
  ".mdx": "mdx",
  ".py": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".sh": "bash",
  ".sql": "sql",
  ".svg": "xml",
  ".toml": "toml",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".txt": "text",
  ".xml": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
};
