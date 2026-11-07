import { readData } from "./server/data-records";
export function x(context: any, id: string) { return readData(context.paseo.workspaces.ref(id), "archive")(); }
