// File icon mapping: extension → { icon, color }
// Icon chars from common unicode symbols, styled to approximate VSCode Material Icons

type IconDef = { icon: string; color: string };

const EXT_MAP: Record<string, IconDef> = {
  // TypeScript / JavaScript
  ts:   { icon: "TS", color: "#3178c6" },
  tsx:  { icon: "TSX", color: "#3178c6" },
  js:   { icon: "JS", color: "#f7df1e" },
  jsx:  { icon: "JSX", color: "#61dafb" },
  mjs:  { icon: "JS", color: "#f7df1e" },
  cjs:  { icon: "JS", color: "#f7df1e" },

  // Web
  html: { icon: "HTML", color: "#e34c26" },
  css:  { icon: "CSS", color: "#264de4" },
  scss: { icon: "SCSS", color: "#cd6799" },
  svg:  { icon: "SVG", color: "#ff9800" },

  // Data / Config
  json: { icon: "{}", color: "#ffd700" },
  yaml: { icon: "YML", color: "#cb171e" },
  yml:  { icon: "YML", color: "#cb171e" },
  toml: { icon: "TOML", color: "#9c4221" },
  env:  { icon: "ENV", color: "#ecd53f" },
  lock: { icon: "🔒", color: "#888" },

  // Docs
  md:   { icon: "MD", color: "#083fa1" },
  mdx:  { icon: "MDX", color: "#083fa1" },
  txt:  { icon: "TXT", color: "#888" },
  pdf:  { icon: "PDF", color: "#e53935" },

  // Backend
  py:   { icon: "PY", color: "#3572A5" },
  rb:   { icon: "RB", color: "#CC342D" },
  go:   { icon: "GO", color: "#00ADD8" },
  rs:   { icon: "RS", color: "#dea584" },
  java: { icon: "JAVA", color: "#b07219" },
  kt:   { icon: "KT", color: "#A97BFF" },
  sh:   { icon: "SH", color: "#4eaa25" },
  bash: { icon: "SH", color: "#4eaa25" },
  zsh:  { icon: "SH", color: "#4eaa25" },

  // Docker / CI
  dockerfile: { icon: "🐳", color: "#2496ed" },
  sql:        { icon: "SQL", color: "#336791" },
};

const FILENAME_MAP: Record<string, IconDef> = {
  "dockerfile":       { icon: "🐳", color: "#2496ed" },
  ".gitignore":       { icon: "GIT", color: "#f14e32" },
  ".gitattributes":   { icon: "GIT", color: "#f14e32" },
  ".env":             { icon: "ENV", color: "#ecd53f" },
  ".env.local":       { icon: "ENV", color: "#ecd53f" },
  "package.json":     { icon: "{}", color: "#cb3837" },
  "tsconfig.json":    { icon: "TS", color: "#3178c6" },
  "vite.config.ts":   { icon: "⚡", color: "#646cff" },
  "bun.lock":         { icon: "🔒", color: "#888" },
};

export function getFileIcon(path: string): IconDef {
  const name = path.split("/").pop() ?? path;
  const lower = name.toLowerCase();

  if (FILENAME_MAP[lower]) return FILENAME_MAP[lower];

  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return EXT_MAP[ext] ?? { icon: "•", color: "#aaa" };
}

export function getLang(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript",
    js: "javascript", jsx: "javascript", mjs: "javascript",
    json: "json", html: "html", css: "css", scss: "scss",
    py: "python", rb: "ruby", go: "go", rs: "rust",
    sh: "bash", bash: "bash", zsh: "bash",
    sql: "sql", yaml: "yaml", yml: "yaml", md: "markdown",
    toml: "ini",
  };
  return map[ext] ?? "plaintext";
}
