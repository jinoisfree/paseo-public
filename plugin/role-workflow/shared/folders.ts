import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const folderRootsSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .refine(
        (value) => value === "~" || value.startsWith("~/") || value.startsWith("/"),
        "절대 경로 또는 ~/로 시작하는 경로를 입력하세요.",
      ),
  )
  .min(1)
  .max(8)
  .default(["~/paseo-work"]);

export const folderList = defineRpc({
  name: "workflow.folders",
  input: z.object({}),
  output: z.object({
    roots: z.array(z.string()),
    folders: z.array(
      z.object({
        name: z.string(),
        path: z.string(),
        displayPath: z.string(),
        realPath: z.string(),
        registered: z.boolean().nullable(),
      }),
    ),
    errors: z.array(z.string()),
  }),
});
