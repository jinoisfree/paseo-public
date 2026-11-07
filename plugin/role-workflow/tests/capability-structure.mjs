/**
 * Catch accidental plugin policy bypasses; deliberate malicious in-process code is out of scope.
 * File allowlists cover raw SDK/pin imports and timeline/archive/pin handles, context.paseo
 * may flow only into attach, and lifecycle creation/registration, destructuring and prototype
 * access stay at their composition/operation boundaries. Ordinary computed data access and
 * Reflect.get are allowed: capability isolation, not a JavaScript sandbox, owns the policy.
 */
import { parse } from "@babel/parser";

const lifecycleFiles = new Set(["server/workspace-lifecycle.ts"]);
const cardFiles = new Set(["server/timeline-cards.ts"]);
/** Deny new capability consumers by default, including entrypoints and nested server modules. */
export function capabilityViolations(source, file) {
  const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
  const violations = [];
  const lifecycle = lifecycleFiles.has(file), cards = cardFiles.has(file);
  const report = (node, reason) => violations.push(`${file}:${node.loc.start.line} ${reason}`);
  const constants = new Map();
  const literal = node => {
    if (node?.type === "StringLiteral") return node.value;
    if (node?.type === "Identifier") return constants.get(node.name);
    if (node?.type === "TemplateLiteral" && !node.expressions.length) return node.quasis[0].value.cooked;
    if (node?.type === "BinaryExpression" && node.operator === "+") {
      const a = literal(node.left), b = literal(node.right);
      if (typeof a === "string" && typeof b === "string") return a + b;
    }
  };
  const key = node => node?.type === "Identifier" ? node.name : literal(node);
  const policyMethods = new Set(["pinWorkspace", "unpinOwned", "archive", "archiveCleaned"]);
  const contextNames = new Set(["context"]);
  function collect(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
      const value = literal(node.init);
      if (value !== undefined) constants.set(node.id.name, value);
      if (node.init?.type === "Identifier" && contextNames.has(node.init.name)) contextNames.add(node.id.name);
    }
    if (node.type === "CallExpression" && ["addHook", "handle"].includes(node.callee.property?.name)) {
      const fn = node.arguments.at(-1);
      if (["ArrowFunctionExpression", "FunctionExpression"].includes(fn?.type) && fn.params[1]?.type === "Identifier") contextNames.add(fn.params[1].name);
    }
    for (const v of Object.values(node)) { if (Array.isArray(v)) v.forEach(collect); else if (v && typeof v === "object") collect(v); }
  }
  collect(ast);

  function visit(node, parent, inConstructor = false) {
    if (node?.type === "ClassMethod") inConstructor = node.kind === "constructor";
    if (!node || typeof node !== "object") return;
    if (node.type === "ImportDeclaration" && !lifecycle && file !== "server/engine.ts" && node.specifiers.some(s => s.imported?.name === "bindWorkspaceLifecycle")) report(node, "policy registrar import outside engine");
    if (node.type === "CallExpression" && node.callee.name === "bindWorkspaceLifecycle" && !(file === "server/engine.ts" && inConstructor) && !lifecycle) report(node, "policy registration outside engine");
    if (node.type === "ImportDeclaration" && !lifecycle && !cards && node.source.value.startsWith("@getpaseo/client") &&
      node.importKind !== "type" && node.specifiers.some(s => s.importKind !== "type")) report(node, "raw SDK import outside capability boundary");
    if (node.type === "ImportDeclaration" && !lifecycle &&
      (node.source.value.includes("daemon-client") || node.specifiers.some(s => ["DaemonClient", "createWorkspacePins"].includes(s.imported?.name))))
      report(node, "raw pin import");
    if (["MemberExpression", "OptionalMemberExpression"].includes(node.type)) {
      const name = node.computed ? literal(node.property) : key(node.property);
      if (name === "paseo" && !lifecycle && !cards && !(file === "index.server.ts" && parent?.type === "CallExpression" && parent.callee.type === "Identifier" && parent.callee.name === "attach" && parent.arguments.includes(node)))
        report(node, "raw context API may only flow directly into attach");
      if (node.computed && name === undefined && contextNames.has(node.object.name) && !lifecycle && !cards)
        report(node, "dynamic raw context API access");
      if (name === "prototype" && node.object.name === "WorkspaceLifecycle" && !lifecycle)
        report(node, "lifecycle prototype policy access");
      if (["lifecycle", "createLifecycle"].includes(name) && parent?.type === "CallExpression" && parent.callee === node &&
        (name === "lifecycle" ? parent.arguments.length > 0 : file !== "index.server.ts") && !lifecycle)
        report(node, "lifecycle creation or policy injection outside composition root");
      if (name === "bind" && parent?.type === "CallExpression" && parent.arguments.some(a => a.type === "ObjectExpression" && a.properties.some(p => ["db", "cleanupReadiness"].includes(key(p.key)))) && file !== "server/engine.ts" && !lifecycle)
        report(node, "lifecycle policy registration outside engine constructor");
      if (!cards && name === "timeline") report(node, "raw timeline handle");
      if (!lifecycle && ["archiveWorkspace", "pin", "unpin", "setWorkspacePinned"].includes(name)) report(node, "raw workspace handle");
      if (!lifecycle && name === "archive" && !(file === "server/archives.ts" && source.slice(node.object.start, node.object.end) === "this.host.lifecycle()"))
        report(node, "raw archive handle");
      if (name === "archiveCleaned" && file !== "server/worktree-cleanup.ts") report(node, "cleanup proof outside cleanup");
    }
    if (node.type === "ObjectPattern") for (const p of node.properties ?? []) {
      const name = key(p.key);
      if ((!cards && name === "timeline") || (!lifecycle && ["archiveWorkspace", "pin", "unpin", "setWorkspacePinned", ...policyMethods].includes(name))) report(p, "destructured capability");
      if (name === "paseo" && !lifecycle && !cards) report(p, "destructured raw context API");
    }
    if (node.type === "Identifier" && node.name === "timeline" && !cards) report(node, "timeline identifier");
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => visit(child, node, inConstructor));
      else if (value && typeof value === "object") visit(value, node, inConstructor);
    }
  }
  visit(ast);
  return violations;
}
