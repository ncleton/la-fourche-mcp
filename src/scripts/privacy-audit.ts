import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";

const roots = ["src", "README.md", "AGENTS.md", ".env.example"];
const forbidden = [
  /(?:password|mot_de_passe)\s*[=:]\s*["'][^"']{4,}/i,
  /(?:cookie|authorization)\s*[=:]\s*["'](?!Bearer \$)[^"']{12,}/i,
  /CAMOFOX_API_KEY\s*=\s*[^\s#]{8,}/,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./,
  /[A-Za-z0-9._%+-]+@(?!example\.|test\.)[A-Za-z0-9.-]+\.(?:com|fr|net|org)\b/,
];

function files(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)]);
  } catch { return [path]; }
}

const candidates = roots.flatMap(files).filter((file) => [".ts", ".md", ".example"].includes(extname(file)) || file.endsWith("AGENTS.md"));
const findings = candidates.flatMap((file) => {
  const content = readFileSync(file, "utf8");
  return forbidden.flatMap((pattern) => pattern.test(content) ? [`${file}: ${pattern}`] : []);
});
if (findings.length) {
  process.stderr.write(`Audit de confidentialité refusé:\n${findings.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Audit de confidentialité réussi (${candidates.length} fichiers).\n`);
}
