# WorkflowEngine 상태 전이

`server/engine.ts`의 상태 머신을 메서드 기준으로 정리한 문서입니다. `engine.ts`를 나눌 때 기준으로 씁니다. 줄 번호는 바뀌므로 메서드 이름으로 찾으세요. 코드와 다르면 코드가 원본이며, 이 문서를 고칩니다.

## 1. `Workflow.status`: active · paused · needs_input · completed · error

| 전이 | 메서드 | 조건 |
|---|---|---|
| (신규) → active | `enroll` | 처음 보는 대화 |
| needs_input → active | `admitTurn` | 채팅 차단이 아님 |
| paused → active | `admitTurn` | 재시도 대기 중인 같은 역할의 queued 지시에 결정 블록이 옴 |
| completed → active | `admits` | 계획 담당의 note가 아닌 턴. 왕복·응답 횟수를 0으로 초기화 |
| → needs_input / active | `selectionReady`, `selectExecutor`, `acceptSelection` | 구현 담당 선택 전 / 선택 후 |
| active → paused | `pause`, `observe`(대화 보관·소실), `deliver`(`turns ≥ maxTurns`), `plan`(`cycles ≥ maxCycles`, 계획은 `limitPlan`으로 보관) | |
| → paused / needs_input | `answered`, `driven` | 실패 턴(취소면 needs_input) |
| → needs_input | `act`(input 결정), `overrule`(input일 때 queued를 `held`로 보관), `read`(상태 블록 오류가 재요청 후에도 남음), `reassessRepeatedPlan`(같은 계획 3회), `recover`(sent 응답을 이미 처리함) | |
| → completed | `complete` | 판정 통과. 계약3 이상에서 문제가 있으면 needs_input |
| → error | `advance`·`stepWorkflow` 예외, 압축 실패(`startCompaction`, `maintainStandalone`) | |
| error → active | `retryCompaction`, `control(resume)` | |
| 자동 재개 | `retryQuota`, `retryTransient` → `resume(w, "", true)` | 실패하면 원래 상태로 되돌림 |

## 2. `Workflow.phase`: plan · execute · review

`phase`는 `queue()`에서만 바뀝니다.
- `plan()`이 구현 담당에게 지시하면 execute가 됩니다.
- `reviewConflict()`와 `reassessRepeatedPlan`은 review로 바꿉니다.
- `finishGeneralChoice`는 plan으로 바꿉니다.
- 수리·계속·재개(`redirect`, `keepMoving`, 자동 재개)는 현재 phase를 유지합니다.

## 3. 전달 단계

**`pending.stage`: queued → sending → sent.** `uncertain` 단계는 없습니다.

| 전이 | 메서드 | 비고 |
|---|---|---|
| → queued | `queue` | |
| queued → sending | `deliver` | `turns++`, 먼저 저장한 뒤 `port.send` |
| sending → sent | `deliver`, `confirmDelivery` | 기록에 `pending.id`가 있을 때만. 없으면 throw하고 다시 보내지 않음 |
| sending → queued | `resend` | `control(resend)`에서만. 대화가 조용하고 기록에 없을 때 같은 ID로 다시 보냄 |

**전송 중 크래시·시간 초과**
- `deliver`가 `sending`을 만나면 `confirmDelivery`로 처리합니다. 확인이 안 되면 error 상태가 됩니다.
- `transientBlock`은 `sending`을 영구 차단으로 보므로 자동 재개가 일어나지 않습니다.
- Paseo 호출이 시간 예산(`CALL_BUDGETS_MS`, `withCallBudgets`)을 넘겨 실패해도 같은 경로를 탑니다.

**`generalDelivery.stage`: queued → sending → sent | uncertain.** `deliverGeneral`이 기록을 보고 판정하며, 다시 보내지 않습니다. `started`는 사용자가 직접 이어가면 `uncertain`을 해소합니다.

## 4. 멈춤·재개 원인

| 필드 | 설정 | 해제 |
|---|---|---|
| `quotaPause` | `quotaFailure` | 수동 재개(`prepareResume`), `pause`, `complete`, `retryQuota`(한도 도달이나 실패) |
| `transientPause` | `recordTransient` | 수동 재개, `started`(자동이 아닌 턴), 시도 5회 후, `stopTransient`, 설정 끔 |
| 왕복·응답 한도 | `deliver`, `plan` | 수동 재개만 횟수를 0으로 되돌립니다. 자동 재개는 한도에서 멈춥니다(`retryQuota`, `transientBlock`). |
| `held` | `overrule` | `act`(계획 담당 결정으로 복원·폐기), `complete`, `generalize` |
| `asker` | `act`(input), `overrule`, `selectionReady`, `complete` 등 | `record`, `answered`, `redirect`, `chatResume`, 선택 완료. 남아 있으면 메시지 없는 재개를 거부 |
| `planIssue` | `beside` | `answered`, `prepareResume`(수신 확인) |

### 구현 담당 배치 대기

`placeExecutor`는 첫 배치에서 겹치는 미완료 쓰기 작업이 없으면 `isolation: shared`를 저장합니다. 겹치면 `executorPlacement` 설정에 따라 worktree를 만들거나, 선택 대기(`placement.stage: choice`, isolation undecided), 기다리기(`placement.stage: waiting`, isolation shared)로 남깁니다. worktree를 만들 수 없으면 사유와 함께 기다립니다. `prepareMember`는 대기 중 실행 대화 생성을 보류하고 매번 writer/scopes로 미완료 겹침을 다시 계산합니다. `selectPlacement` RPC는 선택 대기에서만 결정을 저장하고 진행합니다. 겹침이 사라지면 탭을 생성·전달하며, 기존 `clearToExecute`의 실행 중 충돌 보호도 이어서 적용합니다. 기존 shared/worktree 결정과 교체 실행 담당은 다시 선택하지 않습니다.

### worktree 자동 정리

`WorkspaceLifecycle`만 archive·pin·unpin의 실제 호출을 수행합니다. 0.15 pin transport도 이 파일 안에서만 생성합니다. 원시 API 연결 참조도 workspace-lifecycle 경계가 보유한다. 진입점은 createWorkspaceAccess가 돌려준 축소 API와 관문 factory만 port로 전달하며, port에는 raw archiveWorkspace·pushReview.pin/unpin이 없습니다. 축소 API는 새로 생성한 작업 공간·대화에서도 원시 보관·timeline 핸들을 내보내지 않습니다. 일반 보관도 연결 worktree이면 미커밋·숨김 Git 변경과 HEAD의 실제 원격 포함을 읽기 명령으로 확인하며, 디렉터리나 상태를 확인하지 못하면 보존합니다. timeline 읽기·구독·strict 카드 append 핸들은 timeline-cards 경계 안에서만 생성합니다. server/와 index.server.ts의 구조 시험은 파일 허용 목록 밖의 raw import·핸들·Reflect.get·비리터럴 computed 접근을 금지합니다. 기존 일반 데이터 인덱싱은 data-records의 own data property 접근으로 구분합니다. 일반 보관 요청은 실행 worktree를 거부하며, cleanup이 증거 복사를 마친 같은 호출의 private 일회용 증표를 발급하고, 엔진에 고정 연결된 검증기가 이를 소비해 ready를 재확인한 경우만 보관합니다. 요청자가 ready 객체나 검증 콜백을 넘길 수 없습니다. 마지막 단계에서 activeTurn·permission을 다시 조회합니다. 고정 상태 기계는 의도·소유 행을 저장하고 이 관문을 사용합니다.

`WorktreeCleanup.run`은 승인된 푸시·ff 반영 뒤와 tick 복구에서 같은 판단을 사용합니다. `worktreeCleanup`은 pending → done/skipped/failed이며 failed는 60초 이상 간격으로 최대 3회 시도합니다. 상태 조회 오류와 사용자 pinned는 pending을 유지하고 attempts를 소모하지 않습니다. worktree 실행 공간은 startPin·pushReview의 자동 고정 대상에서 제외하며, 과거 행의 ownedPinAt은 cleanup의 소유 확인을 위해 유지합니다. 소유 기록과 일치하는 고정만 증거 복사·직전 검사를 통과한 뒤 기존 unpin으로 해제하고 결과와 상태를 재조회합니다. 해제를 확인하지 못하면 pending으로 보존합니다. evidenceFiles는 보관 전에 상태 폴더 복사가 끝났음을 나타내는 복구 체크포인트입니다. 보관 응답이 유실돼도 재조회로 완료를 확인하며 done/skipped는 재실행하지 않습니다. 새 구현 주기는 cleanup을 초기화합니다. 새 plan에서 done인 worktree 또는 실행 대화가 보관되고 디렉터리가 없는 worktree는 worktreeHistory에 남기고 generation+1 실행 담당의 배치를 다시 결정합니다. 미정리 worktree 작업은 archiveCandidate에서 제외해 기존 자동·수동 보관으로 우회하지 못하게 합니다.

정리의 영구 오류는 permanentError·permanentErrors·permanentSince로 저장하고 같은 오류가 연속 3회 이상이며 최초 발생 뒤 10분 이상 지났을 때 failed로 멈춥니다. 원인이 바뀌거나 성공·일시 오류가 나오면 연속 횟수와 최초 시각을 초기화합니다. 최초 시각이 없는 옛 오류 기록은 새 관측부터 시간을 셉니다. 일시 오류와 증거 상한(1000개·200MB) 초과는 pending입니다. 증거는 O_NOFOLLOW로 연 원본 inode·크기·mtime를 확인하며 제한된 버퍼로 복사합니다. Git 숨김 표시·submodule 상태·초기화된 submodule의 미커밋 변경과 원격 미포함 커밋·미반영 HEAD reflog도 보존 조건입니다. reflog의 여러 HEAD는 한 rev-list 프로세스로 포함 여부를 검사합니다. Git 출력 32MiB 또는 HEAD reflog 2000개 상한을 넘으면 사유가 있는 pending으로 보존합니다. finished 작업의 수동 보관은 tick에서도 확인하되 이전 증거 복사를 추정하지 않습니다. 새 worktree.baseBranch는 생성 기준 이름이며 옛 기록은 현재 checkout으로 호환합니다.

## 5. 진입점

| 진입점 | 연결 | 주요 전이 |
|---|---|---|
| `agent.create.after` | `enroll` | 새 workflow |
| `agent.turn.after` | `ended` → `transitionTurn` / `admitTurn` → `advance` → `consume` → `act` | 대부분의 상태 변화 |
| `agent.turn.before` | `started` | transientPause 해제, 충돌 갱신 |
| `agent.permission.before/after` | `permission`, `permissionResolved` | 선택·모드 질문 |
| `agent.archive.after` | `archived` | 보관 처리 |
| 3초 주기 | `tick` → `tidyWorkflow`(푸시 재시도, 일반 전환, quota·transient) → `stepWorkflow`(`observe`/`recover`/`advance`) | |
| RPC | `control`, `selectExecutor`, `selectPlacement`, `configure`, 관리형 푸시 3종, `setProgress`, `setRepositories`, `archiveFinished`, `list` | |

## 6. 모듈 구성

엔진은 상태 저장(`db`/`save`), 직렬 큐(`serial`), 상태 머신의 핵심(턴 접수·판정, 전달, 제목·진행 표시, 푸시 증거)을 맡습니다. 아래 모듈은 각자의 host 인터페이스로 필요한 엔진 기능만 받습니다. 상태 맵의 소유권은 표에 적힌 쪽에 있습니다.

| 모듈 | 파일 | 맡는 일 | 상태 소유 |
|---|---|---|---|
| Recovery | `server/recovery.ts` | 사용 한도·일시 오류 기록, 예산 안의 자동 재개와 중단 안내 | 없음(workflow 필드) |
| Compaction | `server/compaction.ts` | 유휴 대화 압축, 결과 기록, 재시도 | 엔진(`compacting`, `compressionReasons`) |
| ExecutorChoice | `server/executor-choice.ts` | 구현 제품·모델·추론 선택, 카탈로그 검증, 실행 설정 적용 | 없음 |
| WorkspaceLifecycle | `server/workspace-lifecycle.ts` | 모든 보관·고정·해제의 실제 호출과 불변식 검사 | 없음(ready 증표는 같은 호출에서 소비) |
| WorktreeCleanup | `server/worktree-cleanup.ts` | 안전 조건 재확인·증거 복사·관문 정리 요청·재시작 복구 | workflow.worktreeCleanup |
| ManagedPushes | `server/managed-pushes.ts` | 승인된 푸시의 준비·실행·재확인과 결과 적용 | 엔진(실행 기록기, 진행 맵) |
| GeneralMode | `server/general-mode.ts` | 일반개발 담당 선택, 연합 → 일반 전환과 결과 전달 | 없음 |
| PushAudit | `server/push-audit.ts` | 응답 뒤 셸 푸시 감사(직렬 큐 밖, 1건씩) | 모듈(진행 중 감사) |
| Archives | `server/archives.ts` | 보관된 대화 정리, 끝난 작업 보관 | 모듈(점검 시각) |
| worktree | `server/worktree.ts` | 구현 worktree 배치·확인, 푸시 후 ff-only 반영 | 없음 |

남은 분리 후보는 전달(`queue`, `deliver`, `confirmDelivery`, `resend`, `busyWriter`, `context`)과 턴 접수·판정(`admitTurn`, `consume`, `act`, `plan`, `complete`)입니다. 이 둘은 상태 전이의 중심이고 서로 강하게 얽혀 있어, 나누면 오히려 흐름을 추적하기 어려워집니다. 분리는 회귀 테스트를 더 갖춘 뒤에 검토합니다.
