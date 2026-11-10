import { decisionHash } from "../shared/plan-approval";
import type { Decision } from "../shared/decision";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc, type PluginHostProps, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import type { z } from "zod";
import { models, selectExecutor, cancelImplementationReservation, status, reviewOptions, selectPlanReview, type ExecutorModel } from "../shared/contracts";
import type { PlanReview, ReviewSelection } from "../shared/plan-review";
import { type executorPickerCardSchema, picksExecutor, pickerBlockers, pickerDefaultThinking, pickerThinking } from "../shared/executor-picker";
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
  reviewSelection?: Pick<Partial<ReviewSelection>, "enabled" | "provider" | "model" | "thinking">;
  planReview?: Partial<PlanReview>;
  reviewerAgentId?: string | null;
};
const PROVIDERS: [WorkflowProvider, string][] = [["codex", "Codex"], ["claude", "Claude Code"]];

/** Shared rows, selection emphasis, labels, step boxes and action buttons for both pickers. */
function usePickerOptions(theme: PluginHostProps["theme"], busy: boolean) {
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
  const option = (label: string, on: boolean, press: () => void, key = label, disabled = false) => (
    <Pressable key={key} accessibilityRole="button" accessibilityState={{ selected: on }} disabled={busy || disabled}
      onPress={press} style={on ? styles.chosen : styles.choice}>
      <Text style={on ? styles.chosenText : disabled ? styles.muted : styles.text}>{on ? "✓ " : ""}{label}</Text>
    </Pressable>
  );
  /** A selection row with its muted lead label. */
  const line = (label: string, children: ReactNode) => (
    <View style={styles.line}><Text style={styles.label}>{label}</Text><View style={[styles.row, { flex: 1 }]}>{children}</View></View>
  );
  /** A numbered step box whose border and title text say whether its choice is made. */
  const zone = (testID: string, title: string, done: boolean, children: ReactNode) => (
    <View testID={testID} style={{ gap: 8, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: done ? colors.success : colors.warning }}>
      <View style={styles.line}>
        <Text style={styles.text}>{title}</Text>
        <Text style={done ? { color: colors.success } : styles.todo}>{done ? "선택 완료" : "선택 필요"}</Text>
      </View>
      {children}
    </View>
  );
  /** Filled while pressable, outlined and muted while not, from the real disabled value only. */
  const action = (label: string, disabled: boolean, press: () => void) => (
    <Pressable accessibilityRole="button" disabled={disabled} onPress={press}
      style={disabled ? styles.choice : styles.chosen}>
      <Text style={disabled ? styles.muted : styles.chosenText}>{label}</Text>
    </Pressable>
  );
  return { styles, option, line, zone, action };
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
  const { styles, option, line, zone, action } = usePickerOptions(theme, busy);
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
      {choose.length > 0 && <Text style={styles.todo}>{`남은 선택: ${choose.join(", ")}`}</Text>}
      {wait.length > 0 && <Text style={styles.muted}>{`대기: ${wait.join(", ")}`}</Text>}
    </View>
  );
  return (
    <View testID="executor-picker" style={styles.box}>
      <Text style={styles.text}>
        {workflow.heldPlan ? "구현 담당을 선택하면 보관한 계획을 바로 전달합니다." : "구현 담당 선택"}
      </Text>
      {gated && !approval && <Text style={styles.muted}>{earlyDraft ? (reviewChoice.enabled === false ? "계획이 나오면 바로 구현을 시작합니다. 계획 확인 없이 구현이 시작됩니다." : "검증을 통과하면 이 담당으로 바로 구현을 시작합니다.") : "계획이 나오면 그 계획을 확인하고 구현 담당을 고르면 전달합니다."}</Text>}
      {gated && approval && <Text selectable style={styles.text}>{`보관 계획 #${approval.id}\n${approval.summary}\n${approval.handoff}`}</Text>}
      {!!s?.error && <Text style={styles.muted}>{s.error}</Text>}
      {reviewRequired && <PlanReviewPicker workflow={workflow} approval={approval} theme={theme} onChanged={onChanged} choice={reviewChoice} onChoice={setReviewChoice} onComplete={setReviewComplete} title="1. 계획 검증" />}
      {zone("executor-zone", `${reviewRequired ? 2 : 1}. 구현 담당`, !!model && thinking !== null, <>
        {line("제품", PROVIDERS.map(([id, label]) => option(label, provider === id, () => {
          setProvider(id); setModel(""); setThinking(null);
        }, id)))}
        {!catalog && <Text style={styles.muted}>모델 목록을 불러오는 중…</Text>}
        {!!catalog?.error && <Text style={styles.muted}>{catalog.error}</Text>}
        {line("모델", catalog?.models.map((row) => option(row.label, model === row.id, () => {
          setModel(row.id); setThinking(pickerDefaultThinking(row));
        }, row.id)))}
        {!!selected && line("추론", pickerThinking(selected).map((row) => option(row.label, thinking === row.id, () => setThinking(row.id), row.id || "none")))}
      </>)}
      {combinedSetup && zone("placement-zone", "3. 겹칠 때 배치", !!placement, <>
        <Text style={styles.muted}>같은 저장소의 작업과 겹칠 때만 적용합니다.</Text>
        <View style={styles.row}>
          {option("워크트리", placement === "worktree", () => setPlacement("worktree"))}
          {option("앞 작업 대기", placement === "wait", () => setPlacement("wait"))}
        </View>
      </>)}
      {hint("primary-blockers", primaryBlockers)}
      {action(busy ? "확인 중…" : earlyDraft ? "이 설정으로 자동 진행" : "이 담당으로 확정", busy || primaryBlocked, () => void submit())}
      {combinedSetup && approval && <>
        {hint("automatic-blockers", automaticBlockers)}
        {action("이 설정으로 자동 진행", busy || automaticBlocked, () => void submit(false, false, true))}
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
        disabled={busy || !canSubmit || !model || thinking === null} onPress={() => void submit(true)} style={styles.choice}>
        <Text style={styles.text}>미통과로 승인</Text>
      </Pressable>}
      {!!message && <Text style={styles.muted}>{message}</Text>}
    </View>
  );
}

function PlanReviewPicker({ workflow, approval, theme, onChanged, choice, onChoice, onComplete, title }: {
  workflow: Workflow; approval: Workflow["heldApproval"]; theme: PluginHostProps["theme"]; onChanged?: () => void;
  choice: ReviewChoice; onChoice: (choice: ReviewChoice) => void; onComplete: (complete: boolean) => void; title: string;
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
  useEffect(() => onComplete(complete), [complete, onComplete]);
  const { styles, option, line, zone } = usePickerOptions(theme, busy);
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
    <View style={styles.row}>
      {option("끄기", enabled === false, () => update({enabled:false}))}
      {option("켜기", enabled === true, () => update({enabled:true}), "on", !available || pending)}
    </View>
    {!available && <Text style={styles.muted}>적격 검증 후보가 없습니다. 켜진 제품·다른 모델·읽기 전용 모드를 확인하세요.</Text>}
    {enabled && <>
      {line("제품", catalog?.providers.map(p => option(`${PROVIDERS.find(([id]) => id === p.provider)?.[1] ?? p.provider}${p.reason ? ` · ${p.reason}` : ""}`, provider === p.provider, () => {update({provider:p.provider,model:"",thinking:null});}, p.provider, !!p.reason || pending)))}
      {line("모델", models.map(m => option(`${m.label}${m.reason ? ` · ${m.reason}` : ""}`, model === m.id, () => {update({model:m.id,thinking:pickerDefaultThinking(m)});}, m.id, !!m.reason || pending)))}
      {line("추론", selected && pickerThinking(selected).map(o => option(o.label, thinking === o.id, () => update({thinking:o.id}), o.id || "none", pending)))}
    </>}
    {!earlyDraft && option(enabled === true ? "검증 선택·시작" : "검증 끄기 확정", false, () => void submit(), "confirm", (!approval && !earlyDraft) || enabled === null || (enabled && (pending || !provider || !selected || !!selected.reason || thinking === null)))}
    {review?.stage === "limit" && option("검토 1회 더", false, () => void submit(true), "extra", !approval)}
    {review && <Text selectable style={styles.muted}>{`계획 검증 ${review.round}/${review.maxRounds} · ${review.stage} · 판정 ${review.verdict?.verdict ?? "대기"} · 차단 ${review.verdict?.findings.filter(f=>f.severity === "차단").length ?? 0}\n${review.path}\n최종 기록: ${review.outcome ?? "대기"}`}</Text>}
    {!!review?.error && <Text style={styles.muted}>{review.error}</Text>}
    {!!error && <Text style={styles.muted}>{error}</Text>}
  </>);
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
