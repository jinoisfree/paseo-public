import { decisionHash } from "../shared/plan-approval";
import type { Decision } from "../shared/decision";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AccessibilityInfo, Pressable, Text, View } from "react-native";
import { useRpc, type PluginHostProps, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import type { z } from "zod";
import { models, selectExecutor, cancelImplementationReservation, status, reviewOptions, selectPlanReview, type ExecutorModel } from "../shared/contracts";
import { DEFAULT_REVIEW_ROUNDS, reviewProgress, type PlanReview, type ReviewSelection } from "../shared/plan-review";
import { type executorPickerCardSchema, picksExecutor, pickerBlockers, pickerFocus, BLINK_MS, type FocusTarget, pickerDefaultThinking, pickerThinking } from "../shared/executor-picker";
import type { WorkflowProvider } from "../shared/assignment";

type ReviewChoice = { enabled: boolean | null; provider: WorkflowProvider | null; model: string; thinking: string | null };

type Workflow = Parameters<typeof picksExecutor>[0] & {
  id: string;
  planAgentId?: string | null;
  heldPlan?: boolean;
  firstPlan?: boolean;
  brainstorm?: boolean;
  implementationReserved?: boolean;
  reservedPlacement?: "worktree" | "wait" | null;
  heldApproval?: { id: number; decisionHash: string; summary: string; handoff: string } | null;
  selection?: { provider?: WorkflowProvider | null; model?: string; thinking?: string | null; error?: string } | null;
  reviewSelection?: Pick<Partial<ReviewSelection>, "enabled" | "provider" | "model" | "thinking" | "stage">;
  planReview?: Partial<PlanReview>;
  reviewerAgentId?: string | null;
};
const PROVIDERS: [WorkflowProvider, string][] = [["codex", "Codex"], ["claude", "Claude Code"]];

type Emphasis = (target: FocusTarget | undefined, selected: boolean, disabled: boolean) => { testID?: string; style?: { borderWidth: number; borderColor: string } };

/** Shared rows, selection emphasis, labels, step boxes and action buttons for both pickers. */
function usePickerOptions(theme: PluginHostProps["theme"], busy: boolean, focus: FocusTarget | null = null, inheritedEmphasis?: Emphasis) {
  const [reduceMotion, setReduceMotion] = useState(true);
  const [blink, setBlink] = useState({ target: focus, on: true });
  useEffect(() => {
    let live = true, changed = false;
    let subscription: { remove: () => void } | undefined;
    try {
      subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", value => {
        changed = true;
        if (live) setReduceMotion(value);
      });
      void AccessibilityInfo.isReduceMotionEnabled().then(value => {
        if (live && !changed) setReduceMotion(value);
      }).catch(() => { if (live) setReduceMotion(true); });
    } catch { setReduceMotion(true); }
    return () => { live = false; subscription?.remove(); };
  }, []);
  useEffect(() => {
    setBlink({ target: focus, on: true });
    if (!focus || reduceMotion) return;
    const timer = setInterval(() => setBlink(previous => ({ target: focus, on: !previous.on })), BLINK_MS);
    return () => clearInterval(timer);
  }, [focus, reduceMotion]);
  const c = theme.colors;
  const colors = useMemo(
    () => ({ accent: c.accent ?? c.foreground, accentForeground: c.accentForeground ?? "#000",
      warning: c.statusWarning ?? c.foreground, success: c.statusSuccess ?? c.foreground }),
    [c],
  );
  const styles = useMemo(
    () => ({
      box: { gap: 8 },
      row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
      line: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 8 },
      label: { color: c.foregroundMuted, minWidth: 32, paddingVertical: 6 },
      text: { color: c.foreground },
      muted: { color: c.foregroundMuted },
      choice: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: c.border },
      chosen: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: colors.accent, backgroundColor: colors.accent },
      chosenText: { color: colors.accentForeground },
      todo: { color: colors.warning },
    }),
    [c, colors],
  );
  const emphasize: Emphasis = inheritedEmphasis ?? ((target, selected, disabled) =>
    target && focus === target && !selected && !disabled && !busy
      ? { testID: "picker-focus", style: { borderWidth: 2, borderColor: reduceMotion || blink.target !== focus || blink.on ? colors.warning : c.border } }
      : {});
  const option = (label: string, on: boolean, press: () => void, key = label, disabled = false, target?: FocusTarget) => (
    <Pressable key={key} accessibilityRole="button" accessibilityState={{ selected: on }} disabled={busy || disabled}
      testID={emphasize(target, on, busy || disabled).testID}
      onPress={press} style={[on ? styles.chosen : styles.choice, emphasize(target, on, busy || disabled).style]}>
      <Text style={on ? styles.chosenText : disabled ? styles.muted : styles.text}>{on ? "✓ " : ""}{label}</Text>
    </Pressable>
  );
  /** A selection row with its muted lead label. */
  const line = (label: string, children: ReactNode) => (
    <View style={styles.line}><Text style={styles.label}>{label}</Text><View style={[styles.row, { flex: 1 }]}>{children}</View></View>
  );
  /** A numbered step box whose border and title text say whether its choice is made. */
  const zone = (testID: string, title: string, done: boolean, children: ReactNode, status?: string) => (
    <View testID={testID} style={{ gap: 8, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: done ? colors.success : colors.warning }}>
      <View style={styles.line}>
        <Text style={styles.text}>{title}</Text>
        <Text style={done ? { color: colors.success } : styles.todo}>{status ?? (done ? "선택 완료" : "선택 필요")}</Text>
      </View>
      {children}
    </View>
  );
  /** Filled while pressable, outlined and muted while not, from the real disabled value only. */
  const action = (label: string, disabled: boolean, press: () => void, target?: FocusTarget) => (
    <Pressable accessibilityRole="button" disabled={disabled} onPress={press}
      testID={emphasize(target, false, disabled).testID}
      style={[disabled ? styles.choice : styles.chosen, emphasize(target, false, disabled).style]}>
      <Text style={disabled ? styles.muted : styles.chosenText}>{label}</Text>
    </Pressable>
  );
  return { styles, option, line, zone, action, emphasize };
}

/** Picks the federated executor from the live catalog, with every thinking option shown. */
export function ExecutorPicker({
  workflow,
  theme,
  onChanged,
  placementDefault = "ask",
}: { workflow: Workflow; theme: PluginHostProps["theme"]; onChanged?: () => void; placementDefault?: "ask" | "worktree" | "wait" }) {
  const readModels = useRpc(models),
    choose = useRpc(selectExecutor);
  const cancelReservation = useRpc(cancelImplementationReservation);
  const s = workflow.selection;
  // Capture what is displayed. Polling must not silently approve a newer hold.
  const [approval] = useState(workflow.heldApproval);
  const gated = workflow.firstPlan ?? (workflow.contract ?? 1) >= 6;
  const earlyDraft = (workflow.contract ?? 1) >= 7 && workflow.mode === "federated" && !approval;
  const canSubmit = !gated || !!approval || earlyDraft;
  const review = workflow.planReview;
  const reviewRequired = (workflow.contract ?? 1) >= 7;
  const combinedSetup = reviewRequired && gated;
  const canReserve = reviewRequired && workflow.reviewSelection?.enabled === true && !!approval && ["reviewing", "revising"].includes(review?.stage ?? "");
  const [reviewChoice, setReviewChoice] = useState<ReviewChoice>({ enabled: workflow.reviewSelection?.enabled ?? null,
    provider: workflow.reviewSelection?.provider ?? null, model: workflow.reviewSelection?.model ?? "", thinking: workflow.reviewSelection?.thinking ?? null });
  const [reviewComplete, setReviewComplete] = useState(false);
  const [placement, setPlacement] = useState<"worktree" | "wait" | null>(workflow.reservedPlacement ?? (placementDefault === "ask" ? null : placementDefault));
  const [provider, setProvider] = useState<WorkflowProvider>(s?.provider ?? "codex");
  const [catalog, setCatalog] = useState<{ models: ExecutorModel[]; error: string | null } | null>(null);
  const [model, setModel] = useState(s?.provider === provider ? (s.model ?? "") : "");
  const [thinking, setThinking] = useState<string | null>(model && s?.model === model ? (s.thinking ?? null) : null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [reviewButtons, setReviewButtons] = useState({ busy: false, confirm: false });
  useEffect(() => {
    let live = true;
    setCatalog(null);
    readModels({ provider })
      .then((result) => live && setCatalog(result))
      .catch(() => live && setCatalog({ models: [], error: "모델 목록을 불러오지 못했습니다. 다시 시도하세요." }));
    return () => {
      live = false;
    };
  }, [provider, readModels]);
  const selected = catalog?.models.find((row) => row.id === model);
  const blockerInput = { contract: workflow.contract ?? 1, mode: workflow.mode, firstPlan: workflow.firstPlan, approvalHash: approval?.decisionHash ?? null,
    savedReview: workflow.reviewSelection?.enabled ?? null, localReview: reviewChoice.enabled, localReviewComplete: reviewComplete,
    stage: review?.stage, reviewHash: review?.hash, placement, model, thinking };
  const primaryBlockers = pickerBlockers(blockerInput, "primary"), automaticBlockers = pickerBlockers(blockerInput, "automatic");
  const primaryBlocked = primaryBlockers.choose.length + primaryBlockers.wait.length > 0;
  const automaticBlocked = automaticBlockers.choose.length + automaticBlockers.wait.length > 0;
  const focus = pickerFocus({ busy: busy || reviewButtons.busy, stage: review?.stage, earlyDraft, reviewRequired,
    automaticShown: combinedSetup && !!approval, localReview: reviewChoice.enabled, reviewProvider: reviewChoice.provider,
    reviewModel: reviewChoice.model, reviewThinking: reviewChoice.thinking, model, thinking, placement,
    primaryEnabled: !primaryBlocked, automaticEnabled: !automaticBlocked,
    limitApproveEnabled: reviewRequired && canSubmit && !!model && thinking !== null,
    limitExtraEnabled: reviewRequired && !!approval, reviewConfirmEnabled: reviewButtons.confirm, primaryChoose: primaryBlockers.choose });
  const { styles, option, line, zone, action, emphasize } = usePickerOptions(theme, busy, focus);
  const submit = useCallback(async (unverified = false, reserve = false, automatic = earlyDraft) => {
    if (!canSubmit || !model || thinking === null || (automatic && automaticBlocked)) return;
    setBusy(true);
    try {
      const result = await choose({ id: workflow.id, provider, model, thinking, ...(gated && approval ? {holdId: approval.id} : {}), ...(unverified ? {unverified:true} : {}), ...(reserve ? {reserve:true} : {}),
        ...(automatic ? { review: { enabled: reviewChoice.enabled!, ...(reviewChoice.enabled ? {provider: reviewChoice.provider!, model: reviewChoice.model, thinking: reviewChoice.thinking!} : {}) }, placement } : {}) });
      setMessage(result.detail);
      onChanged?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "구현 담당을 선택하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }, [choose, model, onChanged, provider, thinking, workflow.id, gated, approval, canSubmit, earlyDraft, automaticBlocked, reviewChoice, placement]);
  /** Why a button is off: what the user can still pick, and what only the system can finish. */
  const hint = (testID: string, { choose, wait }: ReturnType<typeof pickerBlockers>) => !busy && choose.length + wait.length > 0 && (
    <View testID={testID} style={{ gap: 2 }}>
      {choose.length > 0 && <Text style={styles.todo}>{`먼저 고를 것: ${choose.join(", ")}`}</Text>}
      {wait.length > 0 && <Text style={styles.muted}>{`기다리는 중: ${wait.join(", ")}`}</Text>}
    </View>
  );
  return (
    <View testID="executor-picker" style={styles.box}>
      <Text style={styles.text}>
        {workflow.heldPlan ? "구현 담당을 고르면 보관한 계획을 바로 넘깁니다." : "구현 담당 선택"}
      </Text>
      {gated && !approval && <Text style={styles.muted}>{earlyDraft ? (reviewChoice.enabled === false ? "계획이 나오면 확인 없이 바로 구현을 시작합니다." : "계획이 검증을 통과하면 아래 구현 담당이 바로 구현을 시작합니다.") : "계획이 나오면 내용을 확인한 뒤 구현 담당을 고르세요."}</Text>}
      {gated && approval && <Text selectable style={styles.text}>{`보관 계획 #${approval.id}\n${approval.summary}\n${approval.handoff}`}</Text>}
      {!!s?.error && <Text style={styles.muted}>{s.error}</Text>}
      {reviewRequired && <PlanReviewPicker workflow={workflow} approval={approval} theme={theme} onChanged={onChanged} choice={reviewChoice} onChoice={setReviewChoice} onComplete={setReviewComplete} title="1. 계획 검증" emphasize={emphasize} onButtons={setReviewButtons} />}
      {zone("executor-zone", `${reviewRequired ? 2 : 1}. 구현 담당`, !!model && thinking !== null, <>
        <Text style={styles.muted}>실제로 코드를 고칠 AI를 고르세요.</Text>
        {line("제품", PROVIDERS.map(([id, label]) => option(label, provider === id, () => {
          setProvider(id); setModel(""); setThinking(null);
        }, id)))}
        {!catalog && <Text style={styles.muted}>모델 목록을 불러오는 중…</Text>}
        {!!catalog?.error && <Text style={styles.muted}>{catalog.error}</Text>}
        {line("모델", catalog?.models.map((row) => option(row.label, model === row.id, () => {
          setModel(row.id); setThinking(pickerDefaultThinking(row));
        }, row.id, false, "executor-model")))}
        {!!selected && line("추론", pickerThinking(selected).map((row) => option(row.label, thinking === row.id, () => setThinking(row.id), row.id || "none", false, "executor-thinking")))}
      </>)}
      {combinedSetup && zone("placement-zone", "3. 다른 작업과 겹칠 때", !!placement, <>
        <Text style={styles.muted}>같은 저장소에서 다른 작업이 진행 중일 때만 적용합니다.</Text>
        <View style={styles.row}>
          {option("별도 폴더에서 바로 시작", placement === "worktree", () => setPlacement("worktree"), "worktree", false, "placement")}
          {option("앞 작업이 끝나면 시작", placement === "wait", () => setPlacement("wait"), "wait", false, "placement")}
        </View>
      </>)}
      {hint("primary-blockers", primaryBlockers)}
      {action(busy ? "확인 중…" : earlyDraft ? "이 설정으로 자동 진행" : "이 담당에게 구현 맡기기", busy || primaryBlocked, () => void submit(), "primary")}
      {combinedSetup && approval && <>
        {hint("automatic-blockers", automaticBlockers)}
        {action("이 설정으로 자동 진행", busy || automaticBlocked, () => void submit(false, false, true), "automatic")}
      </>}
      {canReserve && option("검증 통과 시 구현 시작", false, () => void submit(false, true), "reserve", !model || thinking === null)}
      {workflow.implementationReserved && <>
        <Text style={styles.text}>구현 시작 예약됨 — {workflow.reviewSelection?.enabled === false ? "계획이 나오면 바로 구현을 시작합니다." : "검증 통과 후 자동으로 시작합니다."}</Text>
        {option("예약 취소", false, () => { void (async () => {
          setBusy(true);
          try { const result = await cancelReservation({id:workflow.id}); setMessage(result.detail); onChanged?.(); }
          catch (error) { setMessage(String(error)); } finally { setBusy(false); }
        })(); })}
      </>}
      {reviewRequired && review?.stage === "limit" && <Pressable accessibilityRole="button"
        disabled={busy || !canSubmit || !model || thinking === null} onPress={() => void submit(true)} testID={emphasize("review-limit", false, busy || !canSubmit || !model || thinking === null).testID}
        style={[styles.choice, emphasize("review-limit", false, busy || !canSubmit || !model || thinking === null).style]}>
        <Text style={styles.text}>검증 통과 없이 구현</Text>
      </Pressable>}
      {!!message && <Text style={styles.muted}>{message}</Text>}
    </View>
  );
}

function PlanReviewPicker({ workflow, approval, theme, onChanged, choice, onChoice, onComplete, title, emphasize, onButtons }: {
  workflow: Workflow; approval: Workflow["heldApproval"]; theme: PluginHostProps["theme"]; onChanged?: () => void;
  choice: ReviewChoice; onChoice: (choice: ReviewChoice) => void; onComplete: (complete: boolean) => void; title: string; emphasize: Emphasis; onButtons: (state: { busy: boolean; confirm: boolean }) => void;
}) {
  const read = useRpc(reviewOptions), choose = useRpc(selectPlanReview);
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof read>> | null>(null);
  const { enabled, provider, model, thinking } = choice;
  const update = (patch: Partial<ReviewChoice>) => onChoice({ ...choice, ...patch });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const review = workflow.planReview;
  useEffect(() => {
    let live = true;
    read({ id: workflow.id }).then(result => { if (live) setCatalog(result); }).catch(e => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [workflow.id, read]);
  const available = catalog?.providers.some(p => p.models.some(m => !m.reason)) ?? false;
  const models = catalog?.providers.find(p => p.provider === provider)?.models ?? [];
  const selected = models.find(m => m.id === model);
  const earlyDraft = (workflow.contract ?? 1) >= 7 && workflow.mode === "federated" && !approval;
  const pending = ["reviewing", "revising"].includes(review?.stage ?? "");
  const complete = enabled === false || !!(enabled && provider && selected && !selected.reason && thinking !== null);
  const saved = workflow.reviewSelection;
  const stored = complete && saved?.enabled === enabled &&
    (enabled === false || (saved.stage === "ready" && saved.provider === provider && saved.model === model && saved.thinking === thinking));
  useEffect(() => onComplete(complete), [complete, onComplete]);
  const confirmDisabled = (!approval && !earlyDraft) || enabled === null || !!(enabled && (pending || !provider || !selected || !!selected.reason || thinking === null));
  useEffect(() => onButtons({ busy, confirm: !earlyDraft && !busy && !confirmDisabled }), [busy, earlyDraft, confirmDisabled, onButtons]);
  const { styles, option, line, zone } = usePickerOptions(theme, busy, null, emphasize);
  const submit = async (extra = false) => {
    if ((!approval && !earlyDraft) || enabled === null) return;
    setBusy(true);
    try {
      const result = await choose({ id:workflow.id, ...(approval ? {holdId:approval.id} : {}), enabled, ...(extra ? {extra:true} : {}),
        ...(enabled && provider ? {provider,model,thinking:thinking ?? ""} : {}) });
      setError(result.detail); onChanged?.();
    } catch(e) { setError(String(e)); } finally { setBusy(false); }
  };
  return zone("plan-review-picker", title, complete, <>
    <Text style={styles.muted}>{`구현 전에 다른 AI가 계획을 읽고 문제를 찾습니다. 최대 ${review?.maxRounds ?? DEFAULT_REVIEW_ROUNDS}회.`}</Text>
    <View style={styles.row}>
      {option("검증 안 함", enabled === false, () => update({enabled:false}), "off", false, "review-toggle")}
      {option("검증 받기", enabled === true, () => update({enabled:true}), "on", !available || pending, "review-toggle")}
    </View>
    {!available && <Text style={styles.muted}>검증할 수 있는 AI가 없습니다. 계획 담당과 다른 모델을 켜고 읽기 전용 모드를 확인하세요.</Text>}
    {enabled && <>
      {line("제품", catalog?.providers.map(p => option(`${PROVIDERS.find(([id]) => id === p.provider)?.[1] ?? p.provider}${p.reason ? ` · ${p.reason}` : ""}`, provider === p.provider, () => {update({provider:p.provider,model:"",thinking:null});}, p.provider, !!p.reason || pending, "review-provider")))}
      {line("모델", models.map(m => option(`${m.label}${m.reason ? ` · ${m.reason}` : ""}`, model === m.id, () => {update({model:m.id,thinking:pickerDefaultThinking(m)});}, m.id, !!m.reason || pending, "review-model")))}
      {line("추론", selected && pickerThinking(selected).map(o => option(o.label, thinking === o.id, () => update({thinking:o.id}), o.id || "none", pending, "review-thinking")))}
    </>}
    {complete && !stored && <Text style={styles.muted}>{earlyDraft
      ? "선택한 설정은 아직 저장되지 않았습니다. 아래 ‘이 설정으로 자동 진행’을 누르세요."
      : "선택한 설정은 아직 저장되지 않았습니다. 아래 검증 진행 버튼으로 적용하세요."}</Text>}
    {!earlyDraft && option(enabled === true ? "이 AI로 검증 시작" : "검증 없이 진행", false, () => void submit(), "confirm", confirmDisabled, "review-confirm")}
    {review?.stage === "limit" && option("검증 1회 더", false, () => void submit(true), "extra", !approval, "review-limit")}
    {review && <Text selectable style={styles.muted}>{reviewProgress(review, { selection: workflow.reviewSelection, hasPlan: !!workflow.heldApproval })}</Text>}
    {!!review?.error && <Text style={styles.muted}>{review.error}</Text>}
    {!!error && <Text style={styles.muted}>{error}</Text>}
  </>, stored ? "설정 저장됨" : complete ? "선택됨 · 저장 전" : "선택 필요");
}

/** Loads the live workflow that `find` names and offers the picker while it is open. */
function LivePicker({ find, theme, decision }: { find: (rows: Workflow[]) => Workflow | undefined; theme: PluginHostProps["theme"]; decision?: Decision }) {
  const read = useRpc(status);
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [placementDefault, setPlacementDefault] = useState<"ask" | "worktree" | "wait">("ask");
  const load = useCallback(() => {
    read({})
      .then(({ workflows, settings }) => { setPlacementDefault(settings?.executorPlacement ?? "ask"); setWorkflow(find(workflows.filter(picksExecutor)) ?? null); })
      .catch(() => setWorkflow(null));
  }, [find, read]);
  useEffect(() => { load(); const timer = setInterval(load, 3000); return () => clearInterval(timer); }, [load]);
  if (!workflow) return null;
  if (decision && (workflow.firstPlan ?? (workflow.contract ?? 1) >= 6) && (!workflow.heldApproval || decisionHash(decision) !== workflow.heldApproval.decisionHash))
    return <Text style={{color: theme.colors.foregroundMuted}}>이전 계획입니다. 현재 계획을 확인하세요.</Text>;
  return <ExecutorPicker key={`${workflow.id}:${workflow.heldApproval?.id ?? 0}`} workflow={workflow} theme={theme} onChanged={load} placementDefault={placementDefault} />;
}

/** Shown under a plan card: finds the planner's open workflow and offers the picker. */
export function PlanExecutorPicker({ agentId, theme, decision }: { agentId: string; theme: PluginHostProps["theme"]; decision?: Decision }) {
  const find = useCallback((rows: Workflow[]) => rows.find((row) => row.planAgentId === agentId), [agentId]);
  return <LivePicker find={find} theme={theme} decision={decision} />;
}

/** Contract 5 posts at federation; contract 6 posts after the first plan is held. */
export function ExecutorPickerCard({ item, theme }: PluginTimelineItemProps<z.infer<typeof executorPickerCardSchema>>) {
  const id = item.data.workflowId;
  const find = useCallback((rows: Workflow[]) => rows.find((row) => row.id === id), [id]);
  return <LivePicker find={find} theme={theme} />;
}
