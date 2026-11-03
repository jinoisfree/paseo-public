import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc, type PluginHostProps } from "@getpaseo/plugin/client";
import { models, selectExecutor, status, type ExecutorModel } from "../shared/contracts";
import { picksExecutor, pickerDefaultThinking, pickerThinking } from "../shared/executor-picker";
import type { WorkflowProvider } from "../shared/assignment";

type Workflow = Parameters<typeof picksExecutor>[0] & {
  id: string;
  heldPlan?: boolean;
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
    if (!model || thinking === null) return;
    setBusy(true);
    try {
      const result = await choose({ id: workflow.id, provider, model, thinking });
      setMessage(result.detail);
      if (result.ok) onChanged?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "구현 담당을 선택하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }, [choose, model, onChanged, provider, thinking, workflow.id]);
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
      <Pressable accessibilityRole="button" disabled={busy || !model || thinking === null} onPress={() => void submit()}
        style={styles.choice}>
        <Text style={model && thinking !== null ? styles.text : styles.muted}>
          {busy ? "확인 중…" : "이 담당으로 확정"}
        </Text>
      </Pressable>
      {!!message && <Text style={styles.muted}>{message}</Text>}
    </View>
  );
}

/** Shown under a plan card: finds the planner's open workflow and offers the picker. */
export function PlanExecutorPicker({ agentId, theme }: { agentId: string; theme: PluginHostProps["theme"] }) {
  const read = useRpc(status);
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const load = useCallback(() => {
    read({})
      .then(({ workflows }) => setWorkflow(
        workflows.find((row) => row.planAgentId === agentId && picksExecutor(row)) ?? null))
      .catch(() => setWorkflow(null));
  }, [agentId, read]);
  useEffect(load, [load]);
  return workflow ? <ExecutorPicker workflow={workflow} theme={theme} onChanged={load} /> : null;
}
