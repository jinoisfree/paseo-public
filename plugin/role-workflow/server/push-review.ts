import { createHash } from "node:crypto";
import { z } from "zod";
import type { PushTarget } from "../shared/artifacts";

export const pushReviewSchema = z.object({
  key: z.string(),
  workspaces: z.array(
    z.object({
      id: z.string(),
      phase: z.enum(["queued", "sent", "pinned", "acknowledged", "withdrawn"]),
      ownedPinAt: z.string().nullable().default(null),
    }),
  ),
});
export type PushReview = z.infer<typeof pushReviewSchema>;
export interface PushReviewPort {
  get(id: string): Promise<{ pinnedAt: string | null } | null>;
  pin(id: string): Promise<string>;
  unpin(id: string, expectedPinAt: string): Promise<boolean>;
}

export function pushReviewKey(targets: readonly PushTarget[]) {
  return createHash("sha256")
    .update(JSON.stringify(targets.map((t) => [t.repository, t.remote, t.branch, t.commit]).sort()))
    .digest("hex");
}

/** Persist before the pin RPC; a restart must never re-pin something the user released. */
export async function syncPushReview(
  review: PushReview,
  port: PushReviewPort,
  save: () => Promise<void>,
  active = true,
) {
  let changed = false;
  for (const workspace of review.workspaces) {
    if (workspace.phase === "acknowledged") continue;
    const current = await port.get(workspace.id).catch(() => null);
    if (current === null) continue;
    const pinned = !!current.pinnedAt;
    if (!active) {
      if (workspace.phase === "withdrawn") continue;
      if (pinned && workspace.ownedPinAt === current.pinnedAt)
        await port.unpin(workspace.id, workspace.ownedPinAt!);
      workspace.phase =
        !pinned && ["pinned", "sent"].includes(workspace.phase) ? "acknowledged" : "withdrawn";
      workspace.ownedPinAt = null;
      changed = true;
      await save();
      continue;
    }
    if (workspace.phase === "withdrawn") continue;
    if (workspace.phase !== "queued") {
      const phase = pinned ? "pinned" : "acknowledged";
      if (
        workspace.phase !== phase ||
        (workspace.ownedPinAt && workspace.ownedPinAt !== current.pinnedAt)
      ) {
        workspace.phase = phase;
        if (workspace.ownedPinAt !== current.pinnedAt) workspace.ownedPinAt = null;
        changed = true;
        await save();
      }
      continue;
    }
    workspace.phase = pinned ? "pinned" : "sent";
    workspace.ownedPinAt = null;
    changed = true;
    await save();
    if (!pinned) {
      // Even if the acknowledgement is lost, the next read observes the user's choice.
      workspace.ownedPinAt = await port.pin(workspace.id);
      workspace.phase = "pinned";
      await save();
    }
  }
  return changed;
}
