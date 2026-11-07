import { parse } from "@babel/parser";

const lifecycleFiles = new Set(["server/workspace-lifecycle.ts"]);
const cardFiles = new Set(["server/timeline-cards.ts"]);
/** Deny new capability consumers by default, including entrypoints and nested server modules. */
export function capabilityViolations(source, file) {
  const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
  const violations = [];
  const lifecycle = lifecycleFiles.has(file), cards = cardFiles.has(file);
  const report = (node, reason) => violations.push(`${file}:${node.loc.start.line} ${reason}`);
  const key = node => node?.type === "Identifier" ? node.name : node?.value;
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "ImportDeclaration" && !lifecycle && !cards && node.source.value.startsWith("@getpaseo/client") &&
      node.importKind !== "type" && node.specifiers.some(s => s.importKind !== "type")) report(node, "raw SDK import outside capability boundary");
    if (node.type === "ImportDeclaration" && !lifecycle &&
      (node.source.value.includes("daemon-client") || node.specifiers.some(s => ["DaemonClient", "createWorkspacePins"].includes(s.imported?.name))))
      report(node, "raw pin import");
    if (["MemberExpression", "OptionalMemberExpression"].includes(node.type)) {
      const name = key(node.property);
      if (node.computed && !["StringLiteral", "NumericLiteral"].includes(node.property.type) && !lifecycle && !cards)
        report(node, "nonliteral computed capability access");
      if (!cards && name === "timeline") report(node, "raw timeline handle");
      if (!lifecycle && ["archiveWorkspace", "pin", "unpin", "setWorkspacePinned"].includes(name)) report(node, "raw workspace handle");
      if (!lifecycle && name === "archive" && !(file === "server/archives.ts" && source.slice(node.object.start, node.object.end) === "this.host.lifecycle()"))
        report(node, "raw archive handle");
      if (name === "archiveCleaned" && file !== "server/worktree-cleanup.ts") report(node, "cleanup proof outside cleanup");
      if (node.object.type === "Identifier" && node.object.name === "Reflect" && name === "get" && !lifecycle && !cards)
        report(node, "reflective capability access");
    }
    if (node.type === "ObjectPattern") for (const p of node.properties ?? []) {
      const name = key(p.key);
      if ((!cards && name === "timeline") || (!lifecycle && ["archiveWorkspace", "pin", "unpin", "setWorkspacePinned"].includes(name))) report(p, "destructured capability");
    }
    if (node.type === "Identifier" && node.name === "timeline" && !cards) report(node, "timeline identifier");
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  }
  visit(ast);
  return violations;
}
