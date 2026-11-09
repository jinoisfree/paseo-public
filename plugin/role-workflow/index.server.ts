import { eventItems, type OperationalApi } from "./server/timeline-cards";
import { SCREEN_SELECTION_PROMPT } from "./server/executor-selection";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PaseoApi, PaseoAgentConfig } from "@getpaseo/client";
import { randomUUID } from "node:crypto";
import { paseoHome, ownerPolicyPath, legacyPublicConfigs } from "./server/paths";
import { OwnerPolicyStore } from "./server/owner-policy";
import path from "node:path";
import { creationRole } from "./shared/assignment";
import { CURRENT_CONTRACT } from "./shared/capabilities";
import { materializeRules } from "./server/rules";
import { composePrompt, composeCurrentPrompt } from "./server/roles";
import { generalPrompt } from "./server/start-guide";
import {
  modeSelectPrompt,
  progressPrompt,
  pushApprovalPrompt,
  titlePrompt,
} from "./server/protocol";
import { createWorkspaceAccess } from "./server/workspace-lifecycle";
import { WorkflowEngine } from "./server/engine";
import { permissionCommands, PUSH_DENIED_MESSAGE, pushGuardEnv, runsGitPush } from "./server/push-guard";
import { createRepoProbe } from "./server/git";
import { createPort, readCompletedTurn, withCallBudgets } from "./server/paseo-port";
import {
  status,
  configure,
  forgetProject,
  control,
  selectExecutor,
  selectPlanReview,
  reviewOptions,
  selectMode,
  selectPlacement,
  testNotification,
  type Settings,
  models,
  retitle,
  setProgress,
  adoptReviewPins,
  setRepositories,
  archiveFinished,
} from "./shared/contracts";

import { createNotifier } from "./server/notify";
import { preparePush, executePush, recheckPush } from "./shared/managed-push";
import { folderList } from "./shared/folders";
import { listFolders } from "./server/folders";

export default function contribute(server: PluginServerContext) {
  let api: OperationalApi | null = null;
  let fatal: string | null = null;
  let settingsReadable = false;
  let settingsReadError: string | null = null;
  const access = createWorkspaceAccess(paseoHome());
  const port = withCallBudgets(createPort(access.api));
  const directory =
    process.env.PASEO_ROLE_WORKFLOW_STATE_DIR ??
    path.join(paseoHome(), "role-workflow");
  const rulesReady = materializeRules(directory);
  const notifier = createNotifier();
  const engine = new WorkflowEngine(
    path.join(directory, "state.json"),
    port,
    (event) => notifier.send(event),
    createRepoProbe(),
    undefined,
    undefined,
    access.createLifecycle(),
    new OwnerPolicyStore(ownerPolicyPath(), legacyPublicConfigs()),
  );
  interface Seed {
    titled: boolean;
    mode: StartMode;
    config: PaseoAgentConfig;
    env: Record<string, string>;
  }
  const seeds = new Map<string, Seed>();
  const createdSeeds = new Map<string, Seed>();
  let projectSubscription: (() => void) | undefined;
  let syncingProjectTitles = false;
  const syncProjectTitles = () => {
    if (syncingProjectTitles || !api?.projects?.list || !api.workspaces?.list) return;
    syncingProjectTitles = true;
    void engine
      .syncProjectTitles()
      .catch(() => console.error("role-workflow: project title sync failed; will retry"))
      .finally(() => {
        syncingProjectTitles = false;
      });
  };
  const attach = (paseo: PaseoApi) => {
    api = access.attach(paseo);
    if (!projectSubscription && api.projects?.subscribe) {
      projectSubscription = api.projects.subscribe(() => syncProjectTitles());
      syncProjectTitles();
    }
  };
  const report = (error: unknown) => {
    fatal = error instanceof Error ? error.message : String(error);
    console.error("role-workflow:", fatal);
  };
  const removers = [
    server.addHook("agent.create.before", async ({ request }, context) => {
      attach(context.paseo);
      const provider = request.config.provider;
      if (provider !== "claude" && provider !== "codex")
        return { config: request.config, env: request.env };
      // A broken workflow state must not stop every new conversation in Paseo.
      const settings = await engine.startSettings(request.config.cwd, provider).catch((error) => {
        report(error);
        return null;
      });
      if (!settings) return { config: request.config, env: request.env };
      const rulesReadme = await rulesReady;
      const env = request.env ?? {};
      const ready = env.PASEO_ROLE_WORKFLOW_GENERAL_READY === "1";
      const { automated, role, mode: originalMode, gated } = creation(settings, env);
      const mode = ready ? "general" : originalMode;
      const current = automated && env.PASEO_ROLE_WORKFLOW_MANAGED !== "1" && !ready;
      const addsTitle = !!mode && settings.koreanTitle;
      const titles =
        titlePrompts(addsTitle, automated && settings.titleMarker) + pushApprovalPrompt();
      const currentSelection = current && mode !== "general" ? SCREEN_SELECTION_PROMPT : "";
      const systemPrompt = current && mode
        ? composeCurrentPrompt(provider, request.config.systemPrompt, mode, rulesReadme, currentSelection, titles, CURRENT_CONTRACT)
        : ready
          ? await generalPrompt(
              directory,
              request.config.systemPrompt,
              composePrompt(provider, undefined, {
                role,
                rulesReadme,
                automated,
                trailing: titlePrompts(false, automated && settings.titleMarker),
              })!,
              titles,
              rulesReadme,
              "",
            )
          : composePrompt(provider, request.config.systemPrompt, {
              rulesReadme,
              role,
              automated,
              sharedRoles: automated,
              mode: gated
                ? modeSelectPrompt(provider, mode === "undecided" ? "ask" : mode!, true)
                : "",
              trailing: titles,
            })!;
      const config = { ...request.config, systemPrompt };
      if (await hasClaudeStartMode(access.api(), config, env, settings.claudeStartMode)) {
        config.modeId = settings.claudeStartMode;
      }
      if (!mode || ready) return { config, env };
      const token = randomUUID();
      seeds.set(token, {
        titled: !(addsTitle || settings.titleMarker),
        mode,
        // The planner's workspace is never recreated; the engine keeps only what it reads.
        config: {
          provider: config.model ? `${provider}/${config.model}` : provider,
          systemPrompt: request.config.systemPrompt,
          modeId: config.modeId,
          thinkingOptionId: config.thinkingOptionId,
        },
        env,
      });
      if (seeds.size > 200) seeds.delete(seeds.keys().next().value!);
      return {
        config,
        env: { ...env, PASEO_ROLE_WORKFLOW_SEED: token },
      };
    }),
    server.addHook("agent.open.before", async ({ request }, context) => {
      attach(context.paseo);
      const token = request.env.PASEO_ROLE_WORKFLOW_SEED;
      const seed = seeds.get(token);
      if (seed && request.reason === "create") {
        createdSeeds.set(request.agentId, seed);
        seeds.delete(token);
        if (createdSeeds.size > 200) createdSeeds.delete(createdSeeds.keys().next().value!);
      }
      if (request.provider !== "claude" && request.provider !== "codex") return request;
      // Re-applied on every open, so resumed and reloaded sessions keep the guard too.
      const guarded = await engine
        .settings()
        .then((settings) => (settings.shellPushGuard ? pushGuardEnv(directory, request.env) : null))
        .catch((error: unknown) => {
          report(error);
          return null;
        });
      return guarded ? { ...request, env: guarded } : request;
    }),
    server.addHook("agent.create.after", async ({ agent }, context) => {
      attach(context.paseo);
      const seed = createdSeeds.get(agent.id);
      createdSeeds.delete(agent.id);
      if (!seed || agent.parentAgentId || !agent.workspaceId) return;
      // The workspace list can lag the creation event, and one failed read must not leave
      // the conversation outside its workflow for good.
      for (let attempt = 0; attempt < 5; attempt++) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, 1000));
        const snapshot = await port.inspect(agent.id).catch(() => null);
        if (!snapshot) continue;
        await engine
          .enroll(snapshot, seed.config, seed.env, seed.mode, seed.titled, CURRENT_CONTRACT)
          .catch(report);
        return;
      }
      report(new Error(`대화 ${agent.id}를 작업에 연결하지 못했습니다. 대화 상태를 확인하세요.`));
    }),
    server.addHook("agent.turn.after", async (event, context) => {
      attach(context.paseo);
      const turn = await readCompletedTurn(eventItems(event), event.agent.cwd, () =>
        port.history(event.agent.id),
      ).catch((error: unknown) => {
        report(error);
        return null;
      });
      if (!turn) return;
      if (turn.maintenance) {
        await engine.maintenanceEnded(event.agent.id, turn.key, !!turn.compacted, turn.maintenanceId).catch(report);
        return;
      }
      let failure: string | null = null;
      if (event.outcome.kind === "failed") failure = event.outcome.error.message;
      if (event.outcome.kind === "canceled") failure = event.outcome.reason;
      if (event.outcome.kind === "completed")
        await engine.generalTimeline(event.agent.id, eventItems(event), turn.generalAnswers, turn.selectionAnswers, turn.modeAnswer, turn.goal, turn.brainstormAnswer, turn.normalizedModeAnswer);
      await engine
        .ended(
          event.agent.id,
          turn.key,
          turn.text,
          failure,
          turn.goal,
          turn.compacted,
          turn.request,
          event.outcome.kind === "canceled",
          turn.messageIds,
          turn.evidence,
        )
        .catch(report);
      void engine.auditPushes().catch(report);
    }),
    server.addHook("agent.permission.before", async ({ agent, request }, context) => {
      attach(context.paseo);
      if (
        permissionCommands(request.input).some(runsGitPush) &&
        (await engine.settings().catch(() => null))?.shellPushGuard
      ) {
        // The shell guard already makes the push fail; refusing here saves a doomed approval prompt.
        const denied = await access.api().agents
          .ref(agent.id)
          .respondToPermission({
            requestId: request.id,
            response: { behavior: "deny", message: PUSH_DENIED_MESSAGE },
          })
          .then(() => true)
          .catch(() => false);
        if (denied) return;
      }
      await engine.permission(agent.id, request).catch(report);
    }),
    server.addHook("agent.permission.after", async ({ agent, requestId, resolution }, context) => {
      attach(context.paseo);
      await engine.permissionResolved(agent.id, requestId, resolution).catch(report);
    }),
    server.addHook("agent.archive.after", async ({ agent }, context) => {
      attach(context.paseo);
      await engine.archived(agent.id).catch(report);
    }),
    server.addHook("agent.turn.before", async (event, context) => {
      attach(context.paseo);
      await engine.started(event.agent.id).catch(report);
    }),
  ];
  server.handle(status, async (_input, context) => {
    attach(context.paseo);
    try {
      const listed = await engine.list();
      if (settingsReadError && fatal === settingsReadError) fatal = null;
      settingsReadError = null;
      const error = listed.error ?? fatal;
      settingsReadable = !error;
      return { ...listed, error, devices: await notifier.activeCount() };
    } catch (error) {
      report(error);
      settingsReadable = false;
      settingsReadError = fatal;
      return {
        settings: null,
        settingsRevision: null,
        federation: { available: false, reason: "상태를 읽을 수 없습니다." },
        workflows: [],
        archives: [],
        error: fatal,
        devices: 0,
      };
    }
  });
  server.handle(models, async (input, context) => {
    attach(context.paseo);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // The dashboard edits global defaults; listModels accepts an omitted cwd.
      const catalog = await Promise.race([
        access.api().providers.listModels(input.provider ?? "codex"),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("모델 목록 조회 시간이 초과되었습니다.")),
            5000,
          );
        }),
      ]);
      if (catalog.error) return { models: [], error: "모델 목록을 불러오지 못했습니다." };
      return {
        models: (catalog.models ?? [])
          .filter((model) => model.isSelectable !== false)
          .map((model) => ({
            id: model.id,
            label: model.label,
            isDefault: model.isDefault ?? false,
            thinkingOptions: (model.thinkingOptions ?? []).map((option) => ({
              id: option.id,
              label: option.label,
              isDefault: model.defaultThinkingOptionId
                ? option.id === model.defaultThinkingOptionId
                : (option.isDefault ?? false),
            })),
          })),
        error: null,
      };
    } catch {
      return {
        models: [],
        error: "모델 목록을 불러오지 못했습니다. 잠시 후 다시 시도하거나 직접 입력하세요.",
      };
    } finally {
      clearTimeout(timeout);
    }
  });
  server.handle(configure, async (input, context) => {
    attach(context.paseo);
    if (!settingsReadable) throw new Error("설정 상태 조회가 실패했습니다. 상태를 다시 읽은 뒤 저장하세요.");
    return engine.configureWithRevision(input.settings, input.expectedRevision);
  });
  server.handle(folderList, async (_input, context) => {
    attach(context.paseo);
    // A catalog failure must not hide usable folders; null means unknown registration.
    const projects = await access.api().projects.list().catch(() => null);
    return listFolders(
      (await engine.settings()).folderRoots,
      projects?.projects.map((project) => project.projectRootPath) ?? null,
    );
  });
  server.handle(forgetProject, async (input, context) => {
    attach(context.paseo);
    return engine.forgetProject(input.cwd);
  });
  server.handle(retitle, async (input, context) => {
    attach(context.paseo);
    return { rows: await engine.retitle(input.apply, input.unmanaged, input.renumber) };
  });
  server.handle(setProgress, async (input, context) => {
    attach(context.paseo);
    return {
      titles: await engine.setProgress(
        input.number,
        input.progress,
        input.project,
        input.targets,
        input.source,
      ),
    };
  });
  server.handle(preparePush, async (input, context) => {
    attach(context.paseo);
    return engine.prepareManagedPush(input.id);
  });
  server.handle(executePush, async (input, context) => {
    attach(context.paseo);
    return engine.executeManagedPush(input.id, input.requestId, input.approved);
  });
  server.handle(recheckPush, async (input, context) => {
    attach(context.paseo);
    return engine.recheckManagedPush(input.id, input.requestId);
  });
  server.handle(adoptReviewPins, async (input, context) => {
    attach(context.paseo);
    return engine.adoptReviewPins(input.id, input.key, input.pins);
  });
  server.handle(selectPlacement, async (input, context) => {
    attach(context.paseo);
    return engine.selectPlacement(input.id, input.placement);
  });
  server.handle(selectMode, async (input, context) => {
    attach(context.paseo);
    return engine.selectMode(input.id, input.mode);
  });
  server.handle(reviewOptions, async (input, context) => { attach(context.paseo); return engine.reviewOptions(input.id); });
  server.handle(selectPlanReview, async (input, context) => { attach(context.paseo); return engine.selectPlanReview(input.id, input); });
  server.handle(selectExecutor, async (input, context) => {
    attach(context.paseo);
    return engine.selectExecutor(input.id, input);
  });
  server.handle(control, async (input, context) => {
    attach(context.paseo);
    return engine.control(input.id, input.action, input.message);
  });
  server.handle(setRepositories, async (input, context) => {
    attach(context.paseo);
    return engine.setRepositories(input.id, input.paths);
  });
  server.handle(archiveFinished, async (input, context) => {
    attach(context.paseo);
    return engine.archiveFinished(input.apply, input.ids);
  });
  server.handle(testNotification, async (_input, context) => {
    attach(context.paseo);
    const w = (await engine.list()).workflows.find((candidate) => candidate.planAgentId);
    const member = w?.planAgentId ? await port.inspect(w.planAgentId) : null;
    return notifier.send({
      kind: "permission",
      title: "테스트 알림",
      body: "role-workflow 알림 설정 확인",
      agentId: member?.id ?? "",
      workspaceId: member?.workspaceId ?? "",
    });
  });
  // A slow daemon must not queue a tick every 3s ahead of lifecycle events.
  let ticking = false;
  const timer = setInterval(() => {
    if (api && !ticking) {
      ticking = true;
      void engine
        .tick()
        .catch(report)
        .finally(() => {
          ticking = false;
        });
    }
    if (api) void engine.auditPushes().catch(report);
    syncProjectTitles();
  }, 3000);
  return async () => {
    clearInterval(timer);
    projectSubscription?.();
    removers.forEach((remove) => remove());
    await rulesReady;
    await engine.close();
    await access.closeLifecycle();
  };
}

type StartMode = "undecided" | "general" | "federated";
/**
 * A new conversation asks for its mode or starts in the configured one. Either way the
 * federated blocks stay in its prompt, so a general conversation can still switch later.
 */
function creation(settings: Settings, env: Record<string, string>) {
  const managed = env.PASEO_ROLE_WORKFLOW_MANAGED === "1";
  const automated = managed || (settings.autoStart && env.PASEO_ROLE_WORKFLOW_DISABLE !== "1");
  const fresh = automated && !managed;
  let mode: StartMode | null = null;
  if (fresh) mode = settings.askMode ? "undecided" : settings.defaultMode;
  return {
    automated,
    role: creationRole(fresh, env.PASEO_ROLE_WORKFLOW_ROLE),
    mode,
    gated: mode !== null,
  };
}

function titlePrompts(title: boolean, progress: boolean): string {
  return (title ? titlePrompt() : "") + (progress ? progressPrompt() : "");
}

async function hasClaudeStartMode(
  paseo: OperationalApi,
  config: { provider: string; cwd: string; modeId?: string },
  env: Record<string, string>,
  modeId: string,
): Promise<boolean> {
  if (
    config.provider !== "claude" ||
    !modeId ||
    env.PASEO_ROLE_WORKFLOW_MANAGED === "1" ||
    env.PASEO_ROLE_WORKFLOW_DISABLE === "1" ||
    config.modeId === "plan"
  )
    return false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const catalog = await Promise.race([
      paseo.providers.listModes("claude", { cwd: config.cwd }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("mode timeout")), 3000);
      }),
    ]);
    return !catalog.error && !!catalog.modes?.some((mode) => mode.id === modeId);
  } catch {
    // A failed lookup must not block conversation creation.
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
