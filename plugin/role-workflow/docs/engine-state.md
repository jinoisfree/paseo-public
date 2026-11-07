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

## 5. 진입점

| 진입점 | 연결 | 주요 전이 |
|---|---|---|
| `agent.create.after` | `enroll` | 새 workflow |
| `agent.turn.after` | `ended` → `transitionTurn` / `admitTurn` → `advance` → `consume` → `act` | 대부분의 상태 변화 |
| `agent.turn.before` | `started` | transientPause 해제, 충돌 갱신 |
| `agent.permission.before/after` | `permission`, `permissionResolved` | 선택·모드 질문 |
| `agent.archive.after` | `archived` | 보관 처리 |
| 3초 주기 | `tick` → `tidyWorkflow`(푸시 재시도, 일반 전환, quota·transient) → `stepWorkflow`(`observe`/`recover`/`advance`) | |
| RPC | `control`, `selectExecutor`, `configure`, 관리형 푸시 3종, `setProgress`, `setRepositories`, `archiveFinished`, `list` | |

## 6. 분리 후보

모든 모듈은 `serial`, `db()`, `save()`, `touch()`를 함께 쓰므로, 이 넷을 담은 코어 컨텍스트를 주입받는 형태가 전제입니다. 표의 앞쪽일수록 경계가 분명합니다.

| 모듈 | 옮길 메서드 | 필요한 공유 상태 |
|---|---|---|
| worktree (분리 완료: `server/worktree.ts`) | `placeExecutor`, `integrateWorktree`, `workFolder`, `worktreeContext` | probe, port, settings |
| quota/transient | `quotaFailure` ~ `retryTransient` 구간 | `resume`, `now`, `compacting` |
| compaction | `prepareCompaction`, `startCompaction`, `finishCompaction`, `retryCompaction`, `maintainStandalone`, `maintenanceEnded` | `compacting`, `compressionReasons` |
| executor selection | `selectExecutor`, `acceptSelection`, `selectionReady`, `selectedExecutor`, `restoreExecutor`, `catalog` | `advance` |
| general mode | `returnToGeneral`, `transition*`, `deliverGeneral`, `generalize`, `*GeneralChoice` | `busyWriter`, `renameWorkspaces` |
| push / managed push | 관리형 푸시, 증거, 감사, 영수증 | `pushTargets`, `pushEpoch`, `renameWorkspaces` |
| delivery | `queue`, `deliver`, `confirmDelivery`, `resend`, `clearToExecute`, `busyWriter`, `scopes`, `recover`, `context` | `port`, `scopeCache` |
| turn intake·decision | `admitTurn`, `consume`, `answered`, `driven`, `beside`, `overrule`, `read`, `record`, `act`, `complete`, `plan` | delivery, quota |
| view/titles/archive | `list`, `renameWorkspaces`, `retitle`, 보관 | db |
