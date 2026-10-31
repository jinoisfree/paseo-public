import { generalAgentLabel } from "../shared/general-agent";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { RpcOutput } from "@getpaseo/plugin";
import {
  status,
  configure,
  forgetProject,
  control,
  setRepositories,
  setProgress,
  testNotification,
  models,
  type Settings,
} from "../shared/contracts";

import { useControlFeedback } from "./control-feedback";
import { resumeResult } from "../shared/resume";
import { ArchivePanel } from "./archive-panel";
import { ManagedPushPanel, useManagedPushFocus } from "./managed-push-panel";
import { executorDefaults, type WorkflowProvider } from "../shared/assignment";
import { selectedModel, selectExecutorModel } from "../shared/model-selection";
import {
  visibleWorkflows as selectWorkflows,
  workflowLabel,
  type WorkflowFilter,
} from "../shared/workflow-list";

const modeNames = { federated: "연합개발", general: "일반개발", undecided: "방식 미선택" };
const selectedState = { selected: true };
const unselectedState = { selected: false };

export function Dashboard({ theme, navigation }: PluginSurfaceProps) {
  const read = useRpc(status),
    write = useRpc(configure),
    forget = useRpc(forgetProject),
    act = useRpc(control),
    saveRepositories = useRpc(setRepositories),
    saveProgress = useRpc(setProgress),
    testPush = useRpc(testNotification),
    readModels = useRpc(models);
  const [archiveDays, setArchiveDays] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [filter, setFilter] = useState<WorkflowFilter>("all");
  const [executorProvider, setExecutorProvider] = useState<WorkflowProvider>("codex");
  const [catalogs, setCatalogs] = useState<Record<WorkflowProvider, RpcOutput<typeof models>>>({
    codex: { models: [], error: null },
    claude: { models: [], error: null },
  });
  const catalog = catalogs[executorProvider];
  const [data, setData] = useState<RpcOutput<typeof status> | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const execution = executorDefaults(draft, executorProvider);
  const [error, setError] = useState("");
  // A failed poll clears itself on the next success; action errors stay until dismissed.
  const [loadError, setLoadError] = useState("");
  const loads = useRef({ started: 0, applied: 0 });
  const [notice, setNotice] = useState("");
  const controlFeedback = useControlFeedback();
  useEffect(() => setNotice(controlFeedback), [controlFeedback]);
  const [pending, setPending] = useState(false);
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [repositoryDrafts, setRepositoryDrafts] = useState<Record<string, string>>({});
  const [repositoryOpen, setRepositoryOpen] = useState<Record<string, boolean>>({});
  const workflows = data?.workflows ?? [];
  const pushFocus = useManagedPushFocus();
  const visibleWorkflows = selectWorkflows(workflows, filter).sort(
    (left, right) => Number(right.id === pushFocus.id) - Number(left.id === pushFocus.id),
  );
  const c = theme.colors;
  const s = useMemo(
    () => ({
      text: { color: c.foreground },
      muted: { color: c.foregroundMuted },
      error: { color: c.statusDanger },
      success: { color: c.statusSuccess },
      input: {
        color: c.foreground,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: 6,
        padding: 10,
        minWidth: 100,
      },
      button: {
        padding: 10,
        borderRadius: 6,
        backgroundColor: c.surface2,
        opacity: pending ? 0.5 : 1,
      },
      content: { padding: 20, gap: 16 },
      spacing: { gap: 8 },
      surface: { backgroundColor: c.surface0 },
      heading: { color: c.foreground, fontSize: 22, fontWeight: "600" as const },
      title: { color: c.foreground, fontSize: 17, fontWeight: "600" as const },
      card: { gap: 10, padding: 14, borderWidth: 1, borderColor: c.border, borderRadius: 8 },
      row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
    }),
    [c, pending],
  );
  const choiceStyles = useMemo(
    () => ({
      selected: [s.button, { borderWidth: 1, borderColor: c.foreground }],
      unselected: [s.button, { borderWidth: 1, borderColor: c.border }],
    }),
    [s.button, c.foreground, c.border],
  );
  const load = useCallback(async () => {
    // A slow response must not overwrite a newer one that already arrived.
    const sequence = ++loads.current.started;
    try {
      const next = await read({});
      if (sequence < loads.current.applied) return;
      loads.current.applied = sequence;
      setData(next);
      setLoadError("");
      setDraft((previous) => previous ?? next.settings);
    } catch (e) {
      if (sequence < loads.current.applied) return;
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [read]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => {
    if (!pushFocus.id) return;
    setFilter("all");
    void load();
  }, [pushFocus, load]);
  const loadModels = useCallback(async () => {
    await Promise.all(
      (["codex", "claude"] as const).map(async (provider) => {
        let result: RpcOutput<typeof models>;
        try {
          result = await readModels({ provider });
        } catch {
          result = {
            models: [],
            error: "모델 목록을 불러오지 못했습니다. 직접 입력할 수 있습니다.",
          };
        }
        setCatalogs((previous) => ({ ...previous, [provider]: result }));
      }),
    );
  }, [readModels]);
  useEffect(() => {
    if (settingsOpen) void loadModels();
  }, [loadModels, settingsOpen]);
  function thinkingOptions(value: string) {
    return selectedModel(catalog.models, value)?.thinkingOptions ?? [];
  }
  function modelChoice(label: string, value: string, selected: boolean, onPress: () => void) {
    return (
      <Pressable
        key={value}
        accessibilityRole="button"
        accessibilityState={selected ? selectedState : unselectedState}
        disabled={pending}
        onPress={onPress}
        style={selected ? choiceStyles.selected : choiceStyles.unselected}
      >
        <Text style={s.text}>
          {selected ? "✓ " : ""}
          {label}
        </Text>
      </Pressable>
    );
  }
  const run = useCallback(
    async (work: () => Promise<unknown>, success: string) => {
      setPending(true);
      setError("");
      setNotice("");
      try {
        await work();
        if (success) setNotice(success);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setPending(false);
      }
    },
    [load],
  );
  function setMessage(id: string, value: string) {
    setMessages((previous) => ({ ...previous, [id]: value }));
  }
  function resume(id: string) {
    void run(async () => {
      resumeResult(await act({ id, action: "resume", message: messages[id] ?? "" }));
      setMessage(id, "");
    }, "작업을 재개했습니다.");
  }
  const button = useCallback(
    (title: string, onPress: () => void, id?: string) => {
      return (
        <Pressable
          testID={id}
          accessibilityRole="button"
          disabled={pending}
          onPress={onPress}
          style={s.button}
        >
          <Text style={s.text}>{title}</Text>
        </Pressable>
      );
    },
    [pending, s.button, s.text],
  );
  function startModeChoice(settings: Settings) {
    if (settings.askMode) return null;
    return (
      <>
        <Text style={s.text}>모드 질문을 껐을 때 새 대화의 진행 방식</Text>
        <View style={s.row}>
          {modelChoice("일반개발", "general", settings.defaultMode === "general", () =>
            setDraft({ ...settings, defaultMode: "general" }),
          )}
          {modelChoice("연합개발", "federated", settings.defaultMode === "federated", () =>
            setDraft({ ...settings, defaultMode: "federated" }),
          )}
        </View>
      </>
    );
  }
  function archivePanel() {
    return (
      <ArchivePanel
        archives={data?.archives}
        styles={s}
        button={button}
        run={run}
        notice={setNotice}
        error={setError}
      />
    );
  }
  function archiveSettings(settings: Settings) {
    return (
      <>
        <Text style={s.text}>마지막 대화 활동 후 보관 유예 (일)</Text>
        {field(
          "보관 유예 일수",
          archiveDays ?? String(settings.archiveAfterDays),
          (value) => {
            setArchiveDays(value);
            setDraft({ ...settings, archiveAfterDays: /^\d+$/.test(value) ? Number(value) : NaN });
          },
          "workflow-archive-days",
        )}
        <Text style={s.muted}>
          🔵 푸시는 유예 뒤 자동 보관합니다. 🟢 완료는 아래 완료 정리 버튼으로 보관합니다. 고정한
          작업과 응답·권한·질문 대기 중인 작업은 보존합니다.
        </Text>
      </>
    );
  }
  // A planner that never received an executor can go back to working alone.
  function projectChoices() {
    return (
      <>
        {Object.entries(data?.projects ?? {}).map(([cwd, saved]) => (
          <View key={cwd} style={s.spacing}>
            <Text selectable style={s.text}>
              {cwd}
            </Text>
            <Text style={s.muted}>
              {saved.mode === "general" ? "일반개발" : "연합개발"}
              {saved.general ? ` · 구현: ${generalAgentLabel(saved.general)}` : ""}
              {saved.codex
                ? ` · GPT 실행: ${saved.codex.model} (${saved.codex.thinking || "기본 추론"})`
                : ""}
              {saved.claude
                ? ` · Claude 실행: ${saved.claude.model} (${saved.claude.thinking || "기본 추론"})`
                : ""}
            </Text>
            {button(
              "이 프로젝트 선택 초기화",
              () => void run(() => forget({ cwd }), "프로젝트 시작 설정을 초기화했습니다."),
            )}
          </View>
        ))}
      </>
    );
  }
  function settingsPanel() {
    if (!draft || !settingsOpen) return null;
    return (
      <View style={s.card}>
        {button(
          `새 대화 자동 연결: ${draft.autoStart ? "켜짐" : "꺼짐"}`,
          () => setDraft({ ...draft, autoStart: !draft.autoStart }),
          "workflow-auto-start",
        )}
        {(
          [
            ["notifyPermission", "권한 요청 알림"],
            ["notifyStopped", "작업 중단 알림"],
            ["autoResumeQuota", "사용 한도 해소 시 자동 재개"],
            ["autoResumeTransient", "일시 오류 자동 재개"],
            ["notifyCompleted", "작업 완료 알림"],
            ["koreanTitle", "한글 제목"],
            ["titleMarker", "제목 상태 색 표식"],
            ["askMode", "모드 질문"],
            ["askExecutorModel", "실행 모델 질문"],
            ["rememberProjectChoices", "프로젝트별 선택 재사용"],
            ["autoArchivePushed", "🔵 푸시 작업 자동 보관"],
            ["autoPinStarted", "📌 새 작업 시작 시 상단 고정"],
            ["autoPinPushed", "🔵 푸시 완료 시 확인할 때까지 상단 고정"],
          ] as const
        ).map(([key, label]) => (
          <View key={key}>
            {button(`${label}: ${draft[key] ? "켜짐" : "꺼짐"}`, () =>
              setDraft({ ...draft, [key]: !draft[key] }),
            )}
          </View>
        ))}
        <Text style={s.muted}>
          모드 질문을 켜면 새 대화마다 일반개발·연합개발을 선택합니다. 저장된 모델·추론은
          재사용하며, 저장된 진행 방식은 모드 질문을 끈 경우에만 자동 적용합니다.
        </Text>
        {startModeChoice(draft)}
        {archiveSettings(draft)}
        <Text style={s.muted}>
          새 작업 시작 고정은 자동으로 해제하지 않습니다. 직접 풀면 다시 고정하지 않으며, 고정 중인
          작업은 자동 보관에서 제외됩니다.
        </Text>
        <Text style={s.muted}>
          푸시 완료 작업은 [PUSH]로 표시하고 상단에 고정합니다. 직접 고정을 해제해도 푸시 표시는
          유지하며, 같은 커밋은 다시 고정하지 않습니다. 새 단계에서는 푸시 완료로 추가한 고정만
          해제하고 이전 푸시 기록을 보존합니다.
        </Text>
        <Text style={s.text}>등록된 휴대폰 {data?.devices ?? 0}대</Text>
        {button(
          "테스트 알림 보내기",
          () =>
            void run(async () => {
              const result = await testPush({});
              const message = `전송 대상 ${result.tokens}대 · HTTP ${result.status ?? "없음"}${result.error ? ` · ${result.error}` : ""}`;
              if (!result.ok) throw new Error(message);
              setNotice(message);
              return result;
            }, ""),
        )}
        <Text style={s.text}>자동 압축 기준 (%)</Text>
        {field(
          "자동 압축 기준",
          String(Math.round(draft.threshold * 100)),
          (value) => setDraft({ ...draft, threshold: Number(value) / 100 }),
          "workflow-threshold",
        )}
        <Text style={s.text}>최대 계획·실행 반복 / 최대 자동 응답 수</Text>
        <View style={s.row}>
          {field("최대 반복 횟수", String(draft.maxCycles), (value) =>
            setDraft({ ...draft, maxCycles: Number(value) }),
          )}
          {field("최대 자동 응답 수", String(draft.maxTurns), (value) =>
            setDraft({ ...draft, maxTurns: Number(value) }),
          )}
        </View>
        <View style={s.row}>
          {modelChoice("GPT 구현 설정", "codex", executorProvider === "codex", () =>
            setExecutorProvider("codex"),
          )}
          {modelChoice("Claude 구현 설정", "claude", executorProvider === "claude", () =>
            setExecutorProvider("claude"),
          )}
        </View>
        <Text style={s.text}>
          실행 모델 ({executorProvider} 또는 {executorProvider}/모델 ID)
        </Text>
        {!!catalog.error && <Text style={s.error}>{catalog.error}</Text>}
        {button("모델 목록 새로고침", () => void loadModels())}
        <View style={s.row}>
          {modelChoice(
            "제공자 기본 모델",
            executorProvider,
            execution.model === executorProvider,
            () =>
              setDraft(
                selectExecutorModel(draft, executorProvider, catalog.models, executorProvider),
              ),
          )}
          {catalog.models.map((model) =>
            modelChoice(
              model.label,
              `${executorProvider}/${model.id}`,
              execution.model === `${executorProvider}/${model.id}`,
              () =>
                setDraft(
                  selectExecutorModel(
                    draft,
                    `${executorProvider}/${model.id}`,
                    catalog.models,
                    executorProvider,
                  ),
                ),
            ),
          )}
        </View>
        {field("실행 모델", execution.model, (value) =>
          setDraft(selectExecutorModel(draft, value, catalog.models, executorProvider)),
        )}
        <Text style={s.text}>실행 추론 정도 (비우면 모델 기본값)</Text>
        <View style={s.row}>
          {modelChoice("모델 기본값", "", execution.thinking === "", () =>
            setDraft({
              ...draft,
              [executorProvider === "claude" ? "claudeExecutorThinking" : "executorThinking"]: "",
            }),
          )}
          {thinkingOptions(execution.model).map((option) =>
            modelChoice(
              `${option.label}${option.isDefault ? " (기본)" : ""}`,
              option.id,
              execution.thinking === option.id,
              () =>
                setDraft({
                  ...draft,
                  [executorProvider === "claude" ? "claudeExecutorThinking" : "executorThinking"]:
                    option.id,
                }),
            ),
          )}
        </View>
        {field("실행 추론 정도", execution.thinking, (value) =>
          setDraft({
            ...draft,
            [executorProvider === "claude" ? "claudeExecutorThinking" : "executorThinking"]: value,
          }),
        )}
        <Text style={s.text}>실행 권한 모드</Text>
        {field("실행 권한 모드", execution.mode, (value) =>
          setDraft({
            ...draft,
            [executorProvider === "claude" ? "claudeExecutorMode" : "executorMode"]: value,
          }),
        )}
        {field(
          "Claude 새 대화 권한 모드 (모든 새 Claude 대화에 적용 · 기본 bypassPermissions · 비우면 앱에서 고른 그대로)",
          draft.claudeStartMode,
          (value) => setDraft({ ...draft, claudeStartMode: value }),
        )}
        {field(
          "폴더 열기 루트 (한 줄에 하나)",
          draft.folderRoots.join("\n"),
          (value) => setDraft({ ...draft, folderRoots: value.split("\n") }),
          undefined,
          true,
        )}
        {button(
          "설정 저장",
          () => void run(() => write(draft), "설정을 저장했습니다."),
          "workflow-save",
        )}
        <Text style={s.muted}>
          자동 연결을 꺼도 이미 연결된 작업은 유지됩니다. 해당 작업에서 일시정지하세요. 모델·권한
          설정은 새 실행 대화부터 사용합니다.
        </Text>
        <Text style={s.text}>프로젝트별 시작 설정</Text>
        <Text style={s.muted}>
          선택한 방식과 실행 모델·추론을 같은 작업 폴더의 새 대화에서 재사용합니다. 초기화하면 다음
          대화는 위의 기본 설정을 따릅니다.
        </Text>
        {projectChoices()}
      </View>
    );
  }
  /** Escapes from a stop that only the user can settle; each says what it skips. */
  function recoveryControls(w: Parameters<typeof workflowLabel>[0]) {
    if (!w.automatic && w.mode !== "federated") return null;
    return (
      <>
        {w.deliveryUnconfirmed && !w.generalTransition && (
          <>
            <Text style={s.muted}>
              마지막 지시의 전달을 확인하지 못했습니다. 담당 대화에 그 지시가 없을 때만 다시
              보냅니다.
            </Text>
            {button(
              "전달 확인 후 다시 보내기",
              () =>
                void run(
                  () => act({ id: w.id, action: "resend", message: "" }),
                  "전달 상태를 확인하고 이어갔습니다.",
                ),
            )}
          </>
        )}
        {w.generalTransition && w.status === "needs_input" && (
          <>
            <Text style={s.muted}>
              전환할 대화의 결과를 확인하지 못했습니다. 확인 없이 전환하면 그 사실을 전환 기록에
              남깁니다.
            </Text>
            {button(
              "확인 없이 일반개발로 전환",
              () =>
                void run(
                  () => act({ id: w.id, action: "general", message: "" }),
                  "일반개발로 전환했습니다.",
                ),
            )}
          </>
        )}
      </>
    );
  }
  function generalButton(id: string) {
    return button(
      "일반개발로 이어가기",
      () =>
        void run(
          () => act({ id, action: "general", message: "" }),
          "일반개발 전환을 요청했습니다. 현재 응답이 끝나면 이어집니다.",
        ),
    );
  }
  function repositoryPanel(w: Parameters<typeof workflowLabel>[0]) {
    const value = repositoryDrafts[w.id] ?? w.repositories?.join("\n") ?? "";
    const trimPath = (entry: string) => entry.trim();
    return (
      <>
        {w.progress === "done" && !w.pushTargets?.length && !w.managedPush && (
          <>
            <Text style={s.muted}>
              조사·답변 또는 로컬 전용 작업을 마쳤다면 푸시 불필요로 완료할 수 있습니다. 원격에 보낼
              변경이나 승인 대기가 있으면 사용하지 마세요.
            </Text>
            {button(
              "푸시 불필요로 완료",
              () =>
                void run(
                  () => saveProgress({ number: w.number, project: w.cwd, progress: "no_push" }),
                  "푸시 불필요로 완료했습니다. 파란색으로 표시하고 완료 접기에 포함합니다.",
                ),
            )}
          </>
        )}
        {!!w.conflict && <Text style={s.error}>{w.conflict}</Text>}
        {!!w.artifactNotice && <Text style={s.muted}>{w.artifactNotice}</Text>}
        {!!w.repositories?.length && (
          <Text style={s.muted}>작업 저장소: {w.repositories.join(", ")}</Text>
        )}
        {!!w.pushTargets?.length && (
          <Text style={s.muted}>
            푸시 대상:{" "}
            {w.pushTargets
              .map(
                (target) =>
                  `${target.repository} → ${target.remote}/${target.branch} (${target.commit.slice(0, 8)})`,
              )
              .join(" · ")}
          </Text>
        )}
        {button(repositoryOpen[w.id] ? "저장소 설정 접기" : "작업 저장소 지정", () =>
          setRepositoryOpen({ ...repositoryOpen, [w.id]: !repositoryOpen[w.id] }),
        )}
        {repositoryOpen[w.id] && (
          <>
            <Text style={s.muted}>
              실제로 수정하는 Git 저장소를 한 줄에 하나씩 입력하세요. 최대 8개이며 작업 폴더 기준
              상대 경로도 가능합니다. 비우면 작업 폴더를 사용합니다.
            </Text>
            {field(
              `${w.title} 작업 저장소`,
              value,
              (next) => setRepositoryDrafts({ ...repositoryDrafts, [w.id]: next }),
              undefined,
              true,
            )}
            {button(
              "작업 저장소 저장",
              () =>
                void run(
                  () =>
                    saveRepositories({
                      id: w.id,
                      paths: value.split("\n").map(trimPath).filter(Boolean),
                    }),
                  "작업 저장소를 저장했습니다.",
                ),
            )}
          </>
        )}
        {w.progress === "pushed" && ["needs_input", "error", "paused"].includes(w.status) && (
          <Text style={s.muted}>이전 변경 푸시됨 · 현재 요청은 확인이 필요합니다</Text>
        )}
      </>
    );
  }
  function field(
    label: string,
    value: string,
    onChangeText: (value: string) => void,
    id?: string,
    multiline = false,
  ) {
    return (
      <TextInput
        accessibilityLabel={label}
        multiline={multiline}
        testID={id}
        style={s.input}
        value={value}
        onChangeText={onChangeText}
      />
    );
  }
  return (
    <ScrollView contentContainerStyle={s.content} style={s.surface}>
      <Text style={s.heading}>개발 작업</Text>
      <Text style={s.muted}>
        답변이 필요한 작업을 먼저 표시합니다. /federate 로 연합개발 전환, /resume 으로 재개, /pause
        로 일시정지할 수 있습니다. /push는 푸시 대상을 보여주며, 별도 승인 버튼을 눌러야 실행됩니다.
        일시정지는 현재 응답을 마친 뒤 적용됩니다.
      </Text>
      {pending && <Text style={s.text}>처리 중…</Text>}
      {!!(error || loadError || data?.error) && (
        <View accessibilityRole="alert">
          <Text testID="workflow-error" style={s.error}>
            {error || loadError || data?.error}
          </Text>
          {button("다시 확인", () => {
            setError("");
            void load();
          })}
        </View>
      )}
      {!!notice && (
        <Text testID="workflow-notice" style={s.success}>
          {notice}
        </Text>
      )}
      {!draft && !error && !loadError && <Text style={s.text}>상태를 불러오는 중…</Text>}
      <View style={s.row}>
        {modelChoice("전체", "all", filter === "all", () => setFilter("all"))}
        {modelChoice("일반개발", "general", filter === "general", () => setFilter("general"))}
        {modelChoice("연합개발", "federated", filter === "federated", () => setFilter("federated"))}
      </View>
      {data && visibleWorkflows.length === 0 && (
        <Text style={s.text}>이 필터에 해당하는 작업이 없습니다.</Text>
      )}
      {visibleWorkflows.map((w) => (
        <View key={w.id} testID={`workflow-${w.id}`} style={s.card}>
          <Text style={s.title}>
            {w.cwd.split("/").findLast(Boolean)} #{String(w.number).padStart(2, "0")} {w.title} ·
            {modeNames[w.mode]} · {workflowLabel(w)}
          </Text>
          <Text style={s.muted}>{w.cwd}</Text>
          <Text style={s.text}>{w.detail}</Text>
          {w.plannerAgent && <Text style={s.muted}>기획·설계·검증 · {generalAgentLabel(w.plannerAgent)}</Text>}
          {w.mode === "general" && w.generalAgent && (
            <Text style={s.muted}>{w.automatic ? "구현 · " : ""}{generalAgentLabel(w.generalAgent)}</Text>
          )}
          {repositoryPanel(w)}
          <ManagedPushPanel workflow={w} refresh={load} styles={s} />
          {(w.automatic || w.mode === "federated") && (
            <Text style={s.muted}>
              반복 {w.cycles}회 · 자동 응답 {w.turns}회 · 압축 계획 {w.planCompactions}회 / 실행{" "}
              {w.executeCompactions}회
            </Text>
          )}
          <View style={s.row}>
            {w.planAgentId &&
              button(
                `${w.automatic || w.mode === "federated" ? "기획·설계·검증" : "대화"}${w.planGeneration > 1 ? w.planGeneration : ""} 열기 · ${w.planUsage === null ? "사용량 미제공" : Math.round(w.planUsage * 100) + "%"}`,
                () => navigation?.openAgent({ agentId: w.planAgentId! }),
              )}
            {w.executeAgentId &&
              button(
                `실행${w.executeGeneration > 1 ? w.executeGeneration : ""} 열기 · ${w.executeUsage === null ? "사용량 미제공" : Math.round(w.executeUsage * 100) + "%"}`,
                () => navigation?.openAgent({ agentId: w.executeAgentId! }),
              )}
          </View>
          {(w.automatic || w.mode === "federated") && w.status === "completed" && (
            <Text style={s.muted}>이 계획 대화에 새 지시를 보내면 다시 시작합니다</Text>
          )}
          {(w.automatic || w.mode === "federated") && !w.generalTransition && w.status !== "completed" && (
            <>
              <Text style={s.muted}>사용자 답변·추가 지시 (필요한 경우)</Text>
              {field(`${w.title} 추가 지시`, messages[w.id] ?? "", (value) =>
                setMessage(w.id, value),
              )}
              {w.status === "active"
                ? button(
                    "일시정지",
                    () =>
                      void run(
                        () => act({ id: w.id, action: "pause", message: "" }),
                        "다음 자동 작업을 일시정지했습니다.",
                      ),
                  )
                : button("재개", () => resume(w.id))}
            </>
          )}
          {recoveryControls(w)}
          {w.mode === "federated" && !w.generalTransition && generalButton(w.id)}
        </View>
      ))}
      {button(
        settingsOpen ? "설정 접기" : "시작 설정·알림·반복 한도",
        () => setSettingsOpen(!settingsOpen),
        "workflow-settings-toggle",
      )}
      {settingsPanel()}
      {archivePanel()}
    </ScrollView>
  );
}
