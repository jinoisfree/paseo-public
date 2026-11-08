import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { settingsValuesSchema } from "../shared/settings-schema";

const file = new URL("../shared/presets/schemas/policy.schema.json", import.meta.url);
const schema = JSON.parse(await readFile(file, "utf8"));
const { $schema: _dialect, ...settings } = z.toJSONSchema(settingsValuesSchema.partial().strict());
schema.properties.roleWorkflow = settings;
await writeFile(file, JSON.stringify(schema, null, 2) + "\n");
