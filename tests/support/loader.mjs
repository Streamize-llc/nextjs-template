// Module hooks for the unit tests (node:test, no bundler): load the TypeScript sources directly (Node strips the types of .ts; .tsx is compiled
// with the TypeScript compiler), resolve the "@/..." alias and extensionless relative imports the way Next does, stub `server-only`, and turn CSS
// imports into empty modules. Everything else is the real code.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

function find(base) {
  for (const suffix of SUFFIXES) {
    const candidate = base + suffix;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") return { url: "data:text/javascript,export default {};", shortCircuit: true };
  let base = null;
  if (specifier.startsWith("@/")) base = path.join(ROOT, "src", specifier.slice(2));
  else if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:") && !path.extname(specifier)) {
    base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
  }
  const found = base && find(base);
  return nextResolve(found ? pathToFileURL(found).href : specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith("file:") && url.endsWith(".css")) return { format: "module", source: "export default {};", shortCircuit: true };
  if (url.startsWith("file:") && url.endsWith(".tsx")) {
    const file = fileURLToPath(url);
    const out = ts.transpileModule(readFileSync(file, "utf8"), {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    });
    return { format: "module", source: out.outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
}
