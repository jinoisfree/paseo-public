import { unknownData } from "../../../server/data-records.ts";
export function x(context: any, id: string) { return (unknownData(context.paseo.workspaces.ref(id), "archive") as () => void)(); }
