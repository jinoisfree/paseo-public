import { decisionHash } from "../shared/plan-approval";
import type { Decision } from "../shared/decision";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc, type PluginHostProps, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import type { z } from "zod";
import { models, selectExecutor, status, reviewOptions, selectPlanReview, type ExecutorModel } from "../shared/contracts";
import type { PlanReview, ReviewSelection } from "../shared/plan-review";
import { type executorPickerCardSchema, picksExecutor, pickerDefaultThinking, pickerThinking } from "../shared/executor-picker";
import type { WorkflowProvider } from "../shared/assignment";

type Workflow = Parameters<typeof picksExecutor>[0] & {
  id: string;
  planAgentId?: string | null;
  heldPlan?: boolean;
  firstPlan?: boolean;
  heldApproval?: { id: number; decisionHash: string; summary: string; handoff: string } | null;
  selection?: { provider?: WorkflowProvider | null; model?: string; thinking?: string | null; error?: string } | null;
  reviewSelection?: Pick<Partial<ReviewSelection>, "enabled" | "provider" | "model" | "thinking">;
  planReview?: Partial<PlanReview>;
  reviewerAgentId?: string | null;
};
const PROVIDERS: [WorkflowProvider, string][] = [["codex", "Codex"], ["claude", "Claude Code"]];

/** Picks the federated executor from the live catalog, with every thinking option shown. */
export function ExecutorPicker({
  workflow,
  theme,
  onChanged,
}: { workflow: Workflow; theme: PluginHostProps["theme"]; onChanged?: () => void }) {
  const readModels = useRpc(models),
    choose = useRpc(selectExecutor);
  const s = workflow.selection;
  // Capture what is displayed. Polling must not silently approve a newer hold.
  const [approval] = useState(workflow.heldApproval);
  const gated = workflow.firstPlan ?? (workflow.contract ?? 1) >= 6;
  const canSubmit = !gated || !!approval;
  const review = workflow.planReview;
  const reviewRequired = (workflow.contract ?? 1) >= 7;
  const reviewReady = !reviewRequired || (workflow.reviewSelection?.enabled === false && !["reviewing", "revising"].includes(review?.stage ?? "")) ||
    (!!approval && review?.stage === "passed" && review.hash === approval.decisionHash);
  const [provider, setProvider] = useState<WorkflowProvider>(s?.provider ?? "codex");
  const [catalog, setCatalog] = useState<{ models: ExecutorModel[]; error: string | null } | null>(null);
  const [model, setModel] = useState(s?.provider === provider ? (s.model ?? "") : "");
  const [thinking, setThinking] = useState<string | null>(model && s?.model === model ? (s.thinking ?? null) : null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const c = theme.colors;
  const styles = useMemo(
    () => ({
      box: { gap: 8 },
      row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
      text: { color: c.foreground },
      muted: { color: c.foregroundMuted },
      choice: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: c.border },
      chosen: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: c.foreground },
    }),
    [c],
  );
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
  const submit = useCallback(async (unverified = false) => {
    if (!canSubmit || !model || thinking === null) return;
    setBusy(true);
    try {
      const result = await choose({ id: workflow.id, provider, model, thinking, ...(gated && approval ? {holdId: approval.id} : {}), ...(unverified ? {unverified:true} : {}) });
      setMessage(result.detail);
      onChanged?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "구현 담당을 선택하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }, [choose, model, onChanged, provider, thinking, workflow.id, gated, approval, canSubmit]);
  const option = (label: string, on: boolean, press: () => void, key = label) => (
    <Pressable key={key} accessibilityRole="button" accessibilityState={{ selected: on }} disabled={busy}
      onPress={press} style={on ? styles.chosen : styles.choice}>
      <Text style={styles.text}>{on ? "✓ " : ""}{label}</Text>
    </Pressable>
  );
  return (
    <View style={styles.box}>
      <Text style={styles.text}>
        {workflow.heldPlan ? "구현 담당을 선택하면 보관한 계획을 바로 전달합니다." : "구현 담당 선택"}
      </Text>
      {gated && !approval && <Text style={styles.muted}>계획이 나오면 그 계획을 확인하고 구현 담당을 고르면 전달합니다.</Text>}
      {gated && approval && <Text selectable style={styles.text}>{`보관 계획 #${approval.id}\n${approval.summary}\n${approval.handoff}`}</Text>}
      {!!s?.error && <Text style={styles.muted}>{s.error}</Text>}
      {reviewRequired && <PlanReviewPicker workflow={workflow} approval={approval} theme={theme} onChanged={onChanged} />}
      <View style={styles.row}>
        {PROVIDERS.map(([id, label]) => option(label, provider === id, () => {
          setProvider(id); setModel(""); setThinking(null);
        }, id))}
      </View>
      {!catalog && <Text style={styles.muted}>모델 목록을 불러오는 중…</Text>}
      {!!catalog?.error && <Text style={styles.muted}>{catalog.error}</Text>}
      <View style={styles.row}>
        {catalog?.models.map((row) => option(row.label, model === row.id, () => {
          setModel(row.id); setThinking(pickerDefaultThinking(row));
        }, row.id))}
      </View>
      {!!selected && (
        <View style={styles.row}>
          {pickerThinking(selected).map((row) => option(row.label, thinking === row.id, () => setThinking(row.id), row.id || "none"))}
        </View>
      )}
      {!reviewReady && <Text style={styles.muted}>계획 검증 선택·판정·기록이 끝날 때까지 구현 승인은 비활성입니다.</Text>}
      <Pressable accessibilityRole="button" disabled={busy || !canSubmit || !reviewReady || !model || thinking === null} onPress={() => void submit()}
        style={styles.choice}>
        <Text style={model && thinking !== null ? styles.text : styles.muted}>
          {busy ? "확인 중…" : "이 담당으로 확정"}
        </Text>
      </Pressable>
      {reviewRequired && review?.stage === "limit" && <Pressable accessibilityRole="button"
        disabled={busy || !canSubmit || !model || thinking === null} onPress={() => void submit(true)} style={styles.choice}>
        <Text style={styles.text}>미통과로 승인</Text>
      </Pressable>}
      {!!message && <Text style={styles.muted}>{message}</Text>}
    </View>
  );
}

function PlanReviewPicker({ workflow, approval, theme, onChanged }: {
  workflow: Workflow; approval: Workflow["heldApproval"]; theme: PluginHostProps["theme"]; onChanged?: () => void;
}) {
  const read = useRpc(reviewOptions), choose = useRpc(selectPlanReview);
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof read>> | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(workflow.reviewSelection?.enabled ?? null);
  const [provider, setProvider] = useState<WorkflowProvider | null>(workflow.reviewSelection?.provider ?? null);
  const [model, setModel] = useState(workflow.reviewSelection?.model ?? "");
  const [thinking, setThinking] = useState<string | null>(workflow.reviewSelection?.thinking ?? null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const c = theme.colors, review = workflow.planReview;
  useEffect(() => {
    let live = true;
    read({ id: workflow.id }).then(result => { if (live) setCatalog(result); }).catch(e => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [workflow.id, read]);
  const available = catalog?.providers.some(p => p.models.some(m => !m.reason)) ?? false;
  const models = catalog?.providers.find(p => p.provider === provider)?.models ?? [];
  const selected = models.find(m => m.id === model);
  const options = selected?.thinkingOptions ?? [];
  const pending = ["reviewing", "revising"].includes(review?.stage ?? "");
  const button = (label: string, press: () => void, disabled = false, chosen = false) => (
    <Pressable key={label} accessibilityRole="button" accessibilityState={{selected:chosen}} disabled={busy || disabled} onPress={press}
      style={{borderWidth:1, borderColor:c.border, borderRadius:8, padding:8}}>
      <Text style={{color: disabled ? c.foregroundMuted : c.foreground}}>{chosen ? "✓ " : ""}{label}</Text>
    </Pressable>
  );
  const submit = async (extra = false) => {
    if (!approval || enabled === null) return;
    setBusy(true);
    try {
      const result = await choose({ id:workflow.id, holdId:approval.id, enabled, ...(extra ? {extra:true} : {}),
        ...(enabled && provider ? {provider,model,thinking:thinking ?? ""} : {}) });
      setError(result.detail); onChanged?.();
    } catch(e) { setError(String(e)); } finally { setBusy(false); }
  };
  return <View style={{gap:8}}>
    <Text style={{color:c.foreground}}>계획 검증</Text>
    <View style={{flexDirection:"row",flexWrap:"wrap",gap:6}}>
      {button("끄기", () => setEnabled(false), false, enabled === false)}
      {button("켜기", () => setEnabled(true), !available || pending, enabled === true)}
    </View>
    {!available && <Text style={{color:c.foregroundMuted}}>적격 검증 후보가 없습니다. 켜진 제품·다른 모델·읽기 전용 모드를 확인하세요.</Text>}
    {enabled && <>
      {catalog?.providers.map(p => button(`${p.provider}${p.reason ? ` · ${p.reason}` : ""}`, () => {setProvider(p.provider);setModel("");setThinking(null);}, !!p.reason || pending, provider === p.provider))}
      {models.map(m => button(`${m.label}${m.reason ? ` · ${m.reason}` : ""}`, () => {setModel(m.id);setThinking(null);}, !!m.reason || pending, model === m.id))}
      {selected && (options.length ? options : [{id:"",label:"추론 없음"}]).map(o => button(o.label, () => setThinking(o.id), pending, thinking === o.id))}
    </>}
    {button(enabled === true ? "검증 선택·시작" : "검증 끄기 확정", () => void submit(), !approval || enabled === null || (enabled && (pending || !provider || !selected || !!selected.reason || thinking === null)))}
    {review?.stage === "limit" && button("검토 1회 더", () => void submit(true), !approval)}
    {review && <Text selectable style={{color:c.foregroundMuted}}>{`계획 검증 ${review.round}/${review.maxRounds} · ${review.stage} · 판정 ${review.verdict?.verdict ?? "대기"} · 차단 ${review.verdict?.findings.filter(f=>f.severity === "차단").length ?? 0}\n${review.path}\n최종 기록: ${review.outcome ?? "대기"}`}</Text>}
    {!!review?.error && <Text style={{color:c.foregroundMuted}}>{review.error}</Text>}
    {!!error && <Text style={{color:c.foregroundMuted}}>{error}</Text>}
  </View>;
}

/** Loads the live workflow that `find` names and offers the picker while it is open. */
function LivePicker({ find, theme, decision }: { find: (rows: Workflow[]) => Workflow | undefined; theme: PluginHostProps["theme"]; decision?: Decision }) {
  const read = useRpc(status);
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const load = useCallback(() => {
    read({})
      .then(({ workflows }) => setWorkflow(find(workflows.filter(picksExecutor)) ?? null))
      .catch(() => setWorkflow(null));
  }, [find, read]);
  useEffect(() => { load(); const timer = setInterval(load, 3000); return () => clearInterval(timer); }, [load]);
  if (!workflow) return null;
  if (decision && (workflow.firstPlan ?? (workflow.contract ?? 1) >= 6) && (!workflow.heldApproval || decisionHash(decision) !== workflow.heldApproval.decisionHash))
    return <Text style={{color: theme.colors.foregroundMuted}}>이전 계획입니다. 현재 계획을 확인하세요.</Text>;
  return <ExecutorPicker key={`${workflow.id}:${workflow.heldApproval?.id ?? 0}`} workflow={workflow} theme={theme} onChanged={load} />;
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
