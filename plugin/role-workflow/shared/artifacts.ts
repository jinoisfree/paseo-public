import { z } from "zod";
import { stripFences } from "./fences";

export const repositoryPathsSchema = z.array(z.string().trim().min(1).max(4096)).max(8);
export const pushTargetSchema = z.object({
  repository: z.string().trim().min(1).max(4096),
  remote: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/),
  branch: z.string().trim().min(1).max(250),
  commit: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
});
export const pushTargetsSchema = z.array(pushTargetSchema).max(8);
export type PushTarget = z.infer<typeof pushTargetSchema>;
export const verificationSchema = z.object({
  command: z.string().min(1).max(4000),
  cwd: z.string().min(1).max(4096),
  commit: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
  exitCode: z.number().int().nullable(),
  logPath: z.string().min(1).max(4096),
  criterion: z.string().max(1000).default(""),
});
export type Verification = z.infer<typeof verificationSchema>;
export const verificationRecordSchema = verificationSchema.extend({
  checkedAt: z.string(),
  state: z.enum(["matched", "failed", "changed", "unavailable"]),
  detail: z.string(),
});

/** Only standalone metadata outside code fences and the structured final block counts. */
export function proseArtifacts(text: string) {
  const prose = stripFences(text).replace(/<paseo-workflow>[^]*?<\/paseo-workflow>/g, "");
  const repositories: string[] = [];
  let pushTargets: PushTarget[] | undefined;
  let invalidTargets = false;
  for (const line of prose.split("\n")) {
    const repository = /^작업저장소:[ \t]*(.+)$/.exec(line)?.[1]?.trim();
    if (repository && repository.length <= 4096) repositories.push(repository);
    const target = /^푸시대상:[ \t]*(.*)$/.exec(line)?.[1];
    if (target === undefined) continue;
    try {
      const parsed = pushTargetsSchema.safeParse(JSON.parse(target));
      if (parsed.success) pushTargets = parsed.data;
      else invalidTargets = true;
    } catch {
      invalidTargets = true;
    }
  }
  return {
    repositories: repositories.length && repositories.length <= 8 ? repositories : undefined,
    pushTargets,
    invalidTargets,
  };
}
