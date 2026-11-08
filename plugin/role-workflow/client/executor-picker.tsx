import { decisionHash } from "../shared/plan-approval";
import type { Decision } from "../shared/decision";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc, type PluginHostProps, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import type { z } from "zod";
import { models, selectExecutor, status, type ExecutorModel } from "../shared/contracts";
import { type executorPickerCardSchema, picksExecutor, pickerDefaultThinking, pickerThinking } from "../shared/executor-picker";
import type { WorkflowProvider } from "../shared/assignment";

type Workflow = Parameters<typeof picksExecutor>[0] & {
  id: string;
  planAgentId?: string | null;
  heldPlan?: boolean;
  firstPlan?: boolean;
  heldApproval?: { id: number; decisionHash: string; summary: string; handoff: string } | null;
  selection?: { provider?: WorkflowProvider | null; model?: string; thinking?: string | null; error?: string } | null;
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
  const submit = useCallback(async () => {
    if (!canSubmit || !model || thinking === null) return;
    setBusy(true);
    try {
      const result = await choose({ id: workflow.id, provider, model, thinking, ...(gated && approval ? {holdId: approval.id} : {}) });
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
      <Pressable accessibilityRole="button" disabled={busy || !canSubmit || !model || thinking === null} onPress={() => void submit()}
        style={styles.choice}>
        <Text style={model && thinking !== null ? styles.text : styles.muted}>
          {busy ? "확인 중…" : "이 담당으로 확정"}
        </Text>
      </Pressable>
      {!!message && <Text style={styles.muted}>{message}</Text>}
    </View>
  );
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
  useEffect(load, [load]);
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
