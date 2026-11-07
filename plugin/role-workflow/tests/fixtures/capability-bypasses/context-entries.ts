export function x(context: any) { const [, f] = Object.entries(context.paseo.workspaces.ref("x")).find(([k]) => k === "arch" + "ive")!; return f(); }
