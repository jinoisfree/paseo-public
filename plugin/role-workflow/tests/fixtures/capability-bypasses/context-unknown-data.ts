import { unknownData } from "../../../server/data-records.ts";
export function x(context: any, id: string) { return (unknownData(context.paseo.agents.ref(id), "time" + "line") as any).append({}); }
