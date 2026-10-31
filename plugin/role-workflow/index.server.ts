import { generalAgentPrompt } from "./server/general-agent-prompt";
import { configChoice } from "./server/general-agent";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PaseoApi, PaseoAgentConfig } from "@getpaseo/client";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { creationRole, executorDefaults, oppositeProvider } from "./shared/assignment";
import { materializeRules } from "./server/rules";
import { composePrompt } from "./server/roles";
import { generalPrompt } from "./server/start-guide";
import {
  executorModelPrompt,
  modeSelectPrompt,
  progressPrompt,
  pushApprovalPrompt,
  titlePrompt,
} from "./server/protocol";
import { WorkflowEngine } from "./server/engine";
import { createRepoProbe } from "./server/git";
import { createWorkspacePins } from "./server/workspace-pins";
import { createPort, readCompletedTurn } from "./server/paseo-port";
import {
  status,
  configure,
  forgetProject,
  control,
  testNotification,
  settingsSchema,
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
  let api: PaseoApi | null = null;
  let fatal: string | null = null;
  const pins = createWorkspacePins(process.env.PASEO_HOME ?? path.join(homedir(), ".paseo"));
  const port = createPort(() => {
    if (!api) throw new Error("Paseo 연결을 기다리고 있습니다.");
    return api;
  }, pins);
  const directory =
    process.env.PASEO_ROLE_WORKFLOW_STATE_DIR ??
    path.join(process.env.PASEO_HOME ?? path.join(homedir(), ".paseo"), "role-workflow");
  const rulesReady = materializeRules(directory);
  const notifier = createNotifier();
  const engine = new WorkflowEngine(
    path.join(directory, "state.json"),
    port,
    (event) => notifier.send(event),
    createRepoProbe(),
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
    api = paseo;
    if (!projectSubscription && paseo.projects?.subscribe) {
      projectSubscription = paseo.projects.subscribe(() => syncProjectTitles());
      syncProjectTitles();
    }
  };
  const report = (error: unknown) => {
    fatal = error instanceof Error ? error.message : String(error);
    console.error("role-workflow:", fatal);
  };
  const selectionPrompts = async (
    config: { provider: string; cwd: string; model?: string; thinkingOptionId?: string },
    paseo: PaseoApi,
    settings: Settings,
    mode: StartMode | null,
    gated: boolean,
    ready: boolean,
  ) => {
    if (ready || !mode) return { generalSelection: "", trailing: "" };
    let generalSelection = "";
    if (settings.askExecutorModel) {
      const preferred =
        (await engine.generalDefault(config.cwd)) ??
        configChoice({
          provider: config.model ? `${config.provider}/${config.model}` : config.provider,
          thinkingOptionId: config.thinkingOptionId,
        });
      const catalogs = await Promise.all(
        (["claude", "codex"] as const).map((base) =>
          modelPrompt(
            paseo,
            config.cwd,
            preferred.provider === base && preferred.model ? `${base}/${preferred.model}` : base,
            false,
            true,
            true,
          ),
        ),
      );
      generalSelection = generalAgentPrompt(
        { claude: catalogs[0], codex: catalogs[1] },
        preferred,
        mode !== "general",
      );
    }
    let trailing = "";
    if (settings.askExecutorModel && mode !== "general") {
      trailing += await modelPrompt(
        paseo,
        config.cwd,
        executorDefaults(settings, oppositeProvider(config.provider)).model,
        gated,
        config.provider === "claude",
      );
    }
    // Without a model catalog the question cannot be offered; fall back to the saved choice.
    if (!trailing && mode !== "general") trailing += savedExecutorPrompt(settings, config.provider);
    if (!settings.askExecutorModel && mode === "general") {
      const preferred = await engine.generalDefault(config.cwd);
      if (preferred) generalSelection = `구현 담당은 저장된 설정 ${preferred.provider}/${preferred.model} · ${preferred.thinking || "모델 기본값"}을 사용한다. 최초 대화는 기획·설계·검증을 유지하고 별도 구현 대화로 자동 인계한다.`;
      else generalSelection = "구현 담당의 저장된 선택이 없다. 최초 모델이 구현을 대신하지 말고 구현 담당 선택을 요청한다.";
      generalSelection = `<paseo-general-agent-v1>\n${generalSelection}\n</paseo-general-agent-v1>`;
    }
    return { generalSelection, trailing };
  };
  const removers = [
    server.before("agent.create", async ({ request }, context) => {
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
      const { generalSelection, trailing } = await selectionPrompts(
        request.config,
        context.paseo,
        settings,
        mode,
        gated,
        ready,
      );
      const addsTitle = !!mode && settings.koreanTitle;
      const titles =
        titlePrompts(addsTitle, automated && settings.titleMarker) + pushApprovalPrompt();
      const systemPrompt =
        ready
          ? await generalPrompt(
              directory,
              request.config.systemPrompt,
              composePrompt(provider, undefined, {
                role,
                rulesReadme,
                automated,
                trailing: trailing + titlePrompts(false, automated && settings.titleMarker),
              })!,
              titles,
              rulesReadme,
              generalSelection,
            )
          : composePrompt(provider, request.config.systemPrompt, {
              rulesReadme,
              role,
              automated,
              sharedRoles: automated,
              mode: gated
                ? modeSelectPrompt(provider, mode === "undecided" ? "ask" : mode!, true)
                : "",
              trailing: trailing + generalSelection + titles,
            })!;
      const config = { ...request.config, systemPrompt };
      if (await hasClaudeStartMode(context.paseo, config, env, settings.claudeStartMode)) {
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
    server.before("agent.session_open", ({ request }, context) => {
      attach(context.paseo);
      const token = request.env.PASEO_ROLE_WORKFLOW_SEED;
      const seed = seeds.get(token);
      if (seed && request.reason === "create") {
        createdSeeds.set(request.agentId, seed);
        seeds.delete(token);
        if (createdSeeds.size > 200) createdSeeds.delete(createdSeeds.keys().next().value!);
      }
      return request;
    }),
    server.on("agent.created", async ({ agent }, context) => {
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
          .enroll(snapshot, seed.config, seed.env, seed.mode, seed.titled, 3)
          .catch(report);
        return;
      }
      report(new Error(`대화 ${agent.id}를 작업에 연결하지 못했습니다. 대화 상태를 확인하세요.`));
    }),
    server.on("agent.turn_ended", async (event, context) => {
      attach(context.paseo);
      const turn = await readCompletedTurn(event.timeline, event.agent.cwd, () =>
        port.history(event.agent.id),
      ).catch((error: unknown) => {
        report(error);
        return null;
      });
      if (!turn || turn.maintenance) return;
      let failure: string | null = null;
      if (event.outcome.kind === "failed") failure = event.outcome.error.message;
      if (event.outcome.kind === "canceled") failure = event.outcome.reason;
      if (event.outcome.kind === "completed")
        await engine.generalTimeline(event.agent.id, event.timeline, turn.generalAnswers);
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
    server.on("agent.permission_requested", async ({ agent, request }, context) => {
      attach(context.paseo);
      await engine.permission(agent.id, request).catch(report);
    }),
    server.on("agent.permission_resolved", async ({ agent, requestId, resolution }, context) => {
      attach(context.paseo);
      await engine.permissionResolved(agent.id, requestId, resolution).catch(report);
    }),
    server.on("agent.archived", async ({ agent }, context) => {
      attach(context.paseo);
      await engine.archived(agent.id).catch(report);
    }),
    server.on("agent.turn_started", async (event, context) => {
      attach(context.paseo);
      await engine.started(event.agent.id).catch(report);
    }),
  ];
  server.handle(status, async (_input, context) => {
    attach(context.paseo);
    try {
      return { ...(await engine.list()), error: fatal, devices: await notifier.activeCount() };
    } catch (error) {
      report(error);
      return {
        settings: settingsSchema.parse({}),
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
        context.paseo.providers.listModels(input.provider ?? "codex"),
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
    return engine.configure(input);
  });
  server.handle(folderList, async (_input, context) => {
    attach(context.paseo);
    // A catalog failure must not hide usable folders; null means unknown registration.
    const projects = await context.paseo.projects.list().catch(() => null);
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
    await pins.close();
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
  paseo: PaseoApi,
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

async function modelPrompt(
  paseo: PaseoApi,
  cwd: string,
  preferred: string,
  gated: boolean,
  bundled: boolean,
  general = false,
): Promise<string> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const catalog = await Promise.race([
      paseo.providers.listModels(preferred.split("/")[0], { cwd }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("model timeout")), 5000);
      }),
    ]);
    if (!catalog.error)
      return executorModelPrompt(catalog.models ?? [], preferred, gated, bundled, general);
  } catch {
    /* Model selection is optional. */
  } finally {
    clearTimeout(timeout);
  }
  return "";
}

function savedExecutorPrompt(settings: Settings, provider: string) {
  const execution = executorDefaults(settings, oppositeProvider(provider));
  let prompt = `\n실행 모델·추론은 저장된 설정을 사용하며 다시 묻지 않는다: ${execution.model} · ${execution.thinking || "모델 기본값"}. 사용자가 이번 작업에서 명시적으로 바꾸면 그 선택을 우선한다.\n`;
  if (execution.model.includes("/"))
    prompt += `첫 plan 상태의 executorModel은 ${execution.model}${execution.thinking ? `, executorThinking은 ${execution.thinking}` : ""}로 기록한다.\n`;
  return `\n<paseo-executor-model-v1>\n[연합개발 전용] 일반개발에서는 이 블록을 적용하지 않는다.\n${prompt}</paseo-executor-model-v1>\n`;
}
