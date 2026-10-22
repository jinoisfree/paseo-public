import { useCallback, useEffect, useMemo, useState, type ComponentType } from "react";
import { Pressable, Text } from "react-native";
import { ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { useRpc, type PluginClientContext, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { RpcOutput } from "@getpaseo/plugin";
import { folderList } from "../shared/folders";

type OpenFolder = (cwd: string) => Promise<{ id: string }>;
type Folder = RpcOutput<typeof folderList>["folders"][number];

function useFolderStyles(theme: PluginSurfaceProps["theme"], busy = false) {
  const c = theme.colors;
  return useMemo(
    () => ({
      surface: { backgroundColor: c.surface0 },
      content: { padding: 20, gap: 14 },
      title: { color: c.foreground, fontSize: 22, fontWeight: "600" as const },
      text: { color: c.foreground },
      name: { color: c.foreground, fontWeight: "600" as const },
      muted: { color: c.foregroundMuted },
      error: { color: c.statusDanger },
      input: {
        color: c.foreground,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: 6,
        padding: 10,
      },
      row: {
        padding: 14,
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: 8,
        gap: 6,
        opacity: busy ? 0.5 : 1,
      },
      sidebar: { padding: 10 },
    }),
    [c, busy],
  );
}

function FolderRow({
  folder,
  theme,
  opening,
  onOpen,
}: {
  folder: Folder;
  theme: PluginSurfaceProps["theme"];
  opening: string;
  onOpen(cwd: string): Promise<void>;
}) {
  const s = useFolderStyles(theme, !!opening);
  const press = useCallback(() => void onOpen(folder.path), [onOpen, folder.path]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${folder.name} 열기`}
      disabled={!!opening}
      onPress={press}
      style={s.row}
    >
      <Text style={s.name}>
        {folder.name}
        {folder.registered ? " · 등록됨" : ""}
        {opening === folder.path ? " · 여는 중…" : ""}
      </Text>
      <Text style={s.muted}>{folder.displayPath}</Text>
      {folder.realPath !== folder.path ? <Text style={s.muted}>{folder.realPath}</Text> : null}
    </Pressable>
  );
}

export function FolderOpenScreen({
  theme,
  host,
  navigation,
  openFolder,
}: PluginSurfaceProps & {
  openFolder: OpenFolder;
}) {
  const read = useRpc(folderList);
  const [data, setData] = useState<RpcOutput<typeof folderList> | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [opening, setOpening] = useState("");
  const s = useFolderStyles(theme);
  const load = useCallback(async () => {
    setError("");
    try {
      setData(await read({}));
    } catch {
      setError("폴더 목록을 불러오지 못했습니다. 다시 시도하세요.");
    }
  }, [read]);
  useEffect(() => {
    void load();
  }, [load]);
  const term = query.trim().toLocaleLowerCase();
  const folders = data?.folders.filter((folder) =>
    [folder.name, folder.displayPath, folder.realPath].some((value) =>
      value.toLocaleLowerCase().includes(term),
    ),
  );
  const open = useCallback(
    async (cwd: string) => {
      if (opening) return;
      setOpening(cwd);
      setError("");
      try {
        const workspace = await openFolder(cwd);
        navigation?.openWorkspace({ workspaceId: workspace.id, serverId: host.id });
      } catch {
        setError("폴더를 열지 못했습니다. 연결 상태와 경로를 확인하세요.");
      } finally {
        setOpening("");
      }
    },
    [opening, openFolder, navigation, host.id],
  );
  return (
    <ScrollView style={s.surface} contentContainerStyle={s.content}>
      <Text style={s.title}>폴더 열기</Text>
      <Text style={s.muted}>
        연결된 서버의 폴더입니다. 루트는 자동 작업 설정에서 바꿀 수 있습니다.
      </Text>
      <TextInput
        accessibilityLabel="폴더 검색"
        placeholder="폴더 이름 또는 경로 검색"
        value={query}
        onChangeText={setQuery}
        style={s.input}
      />
      <Pressable accessibilityRole="button" onPress={load}>
        <Text style={s.text}>새로고침</Text>
      </Pressable>
      {error ? (
        <Text accessibilityRole="alert" style={s.error}>
          {error}
        </Text>
      ) : null}
      {data?.errors.map((message) => (
        <Text key={message} style={s.error}>
          {message}
        </Text>
      ))}
      {!data && !error ? <Text style={s.muted}>폴더를 불러오는 중…</Text> : null}
      {folders?.length === 0 ? <Text style={s.muted}>일치하는 폴더가 없습니다.</Text> : null}
      {folders?.map((folder) => (
        <FolderRow
          key={folder.path}
          folder={folder}
          theme={theme}
          opening={opening}
          onOpen={open}
        />
      ))}
    </ScrollView>
  );
}

// COMPAT(folderScreenAliases): added in v2.0.0, remove after 2027-03-29 when minimum Paseo is 0.11.
// The development SDK is 0.10.3. Prefer 0.11+ APIs, keeping aliases for older hosts.
type ScreenClient = PluginClientContext & {
  addScreen?: (input: {
    id: string;
    title: string;
    Component: ComponentType<PluginSurfaceProps>;
  }) => () => void;
  addSidebarHeaderItem?: (input: {
    id: string;
    title: string;
    Component: ComponentType<SidebarProps>;
  }) => () => void;
  openScreen?: (input: { screenId: string }) => void;
};
type SidebarProps = Pick<PluginSurfaceProps, "theme"> & {
  openScreen(input: { screenId: string }): void;
};
function FolderSidebar({ theme, openScreen }: SidebarProps) {
  const s = useFolderStyles(theme);
  const open = useCallback(() => openScreen({ screenId: "folders" }), [openScreen]);
  return (
    <Pressable accessibilityRole="button" onPress={open} style={s.sidebar}>
      <Text style={s.text}>폴더 열기</Text>
    </Pressable>
  );
}
export function registerFolderOpen(client: PluginClientContext) {
  const current = client as ScreenClient;
  const Screen = (props: PluginSurfaceProps) => {
    const openFolder = useCallback((cwd: string) => client.paseo.workspaces.open(cwd), []);
    return <FolderOpenScreen {...props} openFolder={openFolder} />;
  };
  const open = () =>
    current.openScreen
      ? current.openScreen({ screenId: "folders" })
      : client.openSurface("folders");
  return [
    current.addScreen
      ? current.addScreen({ id: "folders", title: "폴더 열기", Component: Screen })
      : client.addSurface("folders", Screen),
    current.addSidebarHeaderItem
      ? current.addSidebarHeaderItem({
          id: "folders",
          title: "폴더 열기",
          Component: FolderSidebar,
        })
      : client.addSidebarItem({
          id: "folders",
          title: "폴더 열기",
          icon: "FolderOpen",
          surface: "folders",
        }),
    client.addCommandCenterItem({
      id: "folders",
      title: "폴더 열기",
      icon: "FolderOpen",
      context: "global",
      onSelect: open,
    }),
  ];
}
