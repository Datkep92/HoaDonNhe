# Phase gates — FINAL MASTER

## Phase 0

PHASE: 0 — Audit
GOAL: Đọc toàn master, trace integration/policy thật.
PRECONDITIONS: Đúng checkout OneDrive/HoaDonNhe, giữ thay đổi đang có.
CURRENT CODE INTEGRATION POINTS: server/support/data/sqlite/queries/secrets/AI/UI/packaging.
FILES EXPECTED TO CHANGE: AI_INTEGRATION_MAP.md, AI_MASTER_PHASES.md.
CONTRACTS AFFECTED: Chưa đổi runtime trong audit.
RISKS: License không có granular AI entitlements; legacy scope không rõ; nhầm cloud sandbox với local.
TESTS TO RUN: Trace code và đối chiếu master.
ROLLBACK/CHECKPOINT: Docs riêng; không chạm dữ liệu người dùng.

IMPLEMENTED: Audit và inventory gaps, không bịa API/connector.
FILES CHANGED: AI_INTEGRATION_MAP.md, AI_MASTER_PHASES.md.
TEST RESULTS: Trace enforceLicense, offline/trial và adapters thật.
REGRESSION RESULTS: Chưa đổi runtime trong audit.
SECURITY/LICENSE RESULTS: Existing policy xác định; không có entitlement AI riêng.
KNOWN LIMITATIONS: Master chưa đủ; Windows WASM shutdown cần kiểm lại.
ACCEPTANCE GATE: PASS
NEXT PHASE ALLOWED: YES

## Phase 1

PHASE: 1 — Chat core và enforcement tối thiểu bắt buộc
GOAL: Provider abstraction/streaming, identity, scoped session persistence; license trước từng execution, không cache riêng; manifest/flags chặn capability chưa chứng minh.
PRECONDITIONS: Phase 0 PASS; existing enforceLicense là dependency bắt buộc.
CURRENT CODE INTEGRATION POINTS: ai-service/agent/client/router, support.enforceLicense, secrets, ai-chat.
FILES EXPECTED TO CHANGE: src/ai/{identity,model-provider,session-store,access-policy}.js và adapters/tests.
CONTRACTS AFFECTED: License/Capability/ToolResult/Session/Job, versioned metadata.
RISKS: Legacy scope, revoke giữa task, JSON streaming, external/raw data transfer.
TESTS TO RUN: License deny/revoke; native/JSON/stream/outage; company history; migration copy; queue/cancel/artifact/ảnh; existing regressions; packaged smoke/browser.
ROLLBACK/CHECKPOINT: Legacy files giữ nguyên; metadata mới độc lập; không reset dữ liệu gốc/license.

IMPLEMENTED: Streaming/native và strict JSON fallback; identity; SQLite sessions/jobs tách MST; bắt buộc license trước model/tool; manifest và flags; giữ legacy không rõ scope; file/ảnh/queue/cancel.
FILES CHANGED: ai-service, ai-chat, src/ai/*, server, tests/ai-*, packaging verification, AI_SETUP.
TEST RESULTS: 19/19 AI tests; packaged browser PASS; packaged OCR/smoke PASS và 5 lượt smoke tiếp theo đều exit 0.
REGRESSION RESULTS: npm test 886 PASS, 0 FAIL, 7 SKIP do fixture ngoài checkout (893 tests).
SECURITY/LICENSE RESULTS: Authoritative license rechecked, revoke stops next tool; secrets redacted; company history/files isolated; risky executors disabled.
KNOWN LIMITATIONS: Chưa có context/memory, approval engine, persistent datasets hoặc các phase sau. API upstream được mô phỏng, không dùng key trả phí. Production gate chưa PASS.
ACCEPTANCE GATE: PASS
NEXT PHASE ALLOWED: YES

## Phase 2

PHASE: 2 — Context + Memory
GOAL: Context bounded gồm recent/summary/retrieval/refs; raw history local; memory xác nhận rõ và tách công ty; correction theo key supersede; giải tham chiếu file qua typed metadata.
PRECONDITIONS: Phase 1 PASS; license/router là enforcement bắt buộc.
CURRENT CODE INTEGRATION POINTS: session-store, agent context, service stream, tool registry.
FILES EXPECTED TO CHANGE: context-manager, session-store schema v2, agent/service/registry/prompt và tests.
CONTRACTS AFFECTED: ContextBudget, MemoryRecord, Reference, metadata migration v1→v2.
RISKS: Cross-company/global confusion; secret persistence; model treating old prose as current verified data; destructive migration.
TESTS TO RUN: Copy v1 migration/backup, long chat budget/raw retention, scope/retrieval/correction, file reference after restart, secret rejection, AI/browser/regressions.
ROLLBACK/CHECKPOINT: SQLite VACUUM backup trước migration + transaction; raw/legacy history và original data giữ nguyên. Schema mới hơn bị từ chối bởi app cũ.

IMPLEMENTED: Bounded context, summary local, FTS history search, top-K keyword memory, typed persistent file references; user-confirmed keyed correction supersedes; native tool groups compact nguyên cặp.
FILES CHANGED: context-manager, session-store v2, service/agent/registry/prompt, AI_SETUP, verify-exe, ai-master tests.
TEST RESULTS: 22/22 AI PASS; long chat 300 messages/raw retrieval; company separation; v1 migration/backup/future-version preservation; source và packaged browser PASS; build OCR/smoke PASS.
REGRESSION RESULTS: 64 parse/UI/license/trial tests PASS; Phase 1 full regression vẫn là checkpoint (886 PASS/7 SKIP), không đổi module nghiệp vụ gốc ở Phase 2.
SECURITY/LICENSE RESULTS: Secret memory rejected; no memory from model/files; global only explicit user command; scope validated in store and runtime gates remain.
KNOWN LIMITATIONS: Retrieval hiện FTS/keywords, chưa semantic embedding. Dataset references/workflow/schema memory chờ engines Phase 5/7/8; typed file refs đã bền qua restart. Chưa production-ready.
ACCEPTANCE GATE: PASS
NEXT PHASE ALLOWED: YES

## Phase 3

PHASE: 3 — Permission/Approval/Audit
GOAL: Approval bound exact action/args/hash, scope/expiry, deny/revoke/cancel, anti-replay; UI tác động cụ thể; license trước request và sau approval; executor nhận evidence thật.
PRECONDITIONS: Phase 2 PASS; risky features vẫn disabled; không cấp fullAccess.
CURRENT CODE INTEGRATION POINTS: access-policy/router, ai-service stream và internal API, ai-chat DOM cards, audit.
FILES EXPECTED TO CHANGE: permission-engine, access-policy/router/service/chat/style, tests và verify-exe.
CONTRACTS AFFECTED: ApprovalRequest/Grant/Audit; independent permission metadata schema v1 có atomic persistence và restart invalidation.
RISKS: Replay, changed args/MST, cancellation while awaiting, fake model approval, stale persisted grants, key leaks in preview.
TESTS TO RUN: Exact hash/version/scope/expiry/deny/revoke; license revoke while waiting; no side effects on cancel/deny; user UI approval; source/packaged browser and regression.
ROLLBACK/CHECKPOINT: Versioned independent permission file, no edits to app/company/license data; pending approvals invalidated on restart; disabled flags preserve boundary.

IMPLEMENTED: Versioned permission metadata; exact hash/version/scope/fingerprint; once anti-replay; persistent scoped grants/deny/revoke; expiry/cancel/restart invalidation; approval DOM cards và management UI; audit approval evidence. Guard async MST/folder race trong app executor.
FILES CHANGED: permission-engine/access-policy/router/agent/service/chat/style/index, server scope guards, audit, tests/verify/setup.
TEST RESULTS: 24/24 AI PASS, 76 parse/UI/license/trial/lifecycle PASS; source và packaged browser deny→revoke→allow actual MST selection, history/artifact separation PASS; OCR/build/smoke PASS.
REGRESSION RESULTS: npm test 891 PASS, 0 FAIL, 7 SKIP (898 tests).
SECURITY/LICENSE RESULTS: Revoked license after approval prevents executor; fake/replayed/mismatched approval rejected; disabled external/DB write/command capabilities cannot be enabled by approval; pending approvals cancelled on stop/restart.
KNOWN LIMITATIONS: Grants repeat only exact action in same company, narrower than broad full access. Original-file/DB/external/desktop executors still disabled. Other master phases and production gate pending.
ACCEPTANCE GATE: PASS
NEXT PHASE ALLOWED: YES

## Phase 4 — đang thực hiện

PHASE: 4 — HoaDonNhe adapters + verification
GOAL: Reuse actual app wrappers; full invoice item dataset; read-back proof for app actions; never retry an uncertain consequential result.
PRECONDITIONS: Phase 3 PASS; approval and license enforcement mandatory.
CURRENT CODE INTEGRATION POINTS: getAgentServices, data.queries, engine/downloadStatus, registry/router/agent.
FILES EXPECTED TO CHANGE: server adapters, registry/router/agent and tests.
CONTRACTS AFFECTED: ToolResult verification/terminal action errors, app jobId read-back.
RISKS: Truncated items mistaken for full data; started mistaken for completed; side-effect retry after uncertain failure.
TESTS TO RUN: Full item dataset, latest BUY/SELL fields/order, goods semantics, action read-back failure terminal/no repeat, browser selection and regression.
ROLLBACK/CHECKPOINT: Existing public app routes/engines unchanged; AI wrappers only. Read-only data remains immutable; original-file/DB/external flags off.

ACCEPTANCE GATE: PENDING
NEXT PHASE ALLOWED: NO

## Các phase tiếp theo

2. Context/compaction/references/scoped memory.
3. Permission Engine + exact-action approval/anti-replay + audit.
4. HoaDonNhe adapters qua cùng access controller.
5. Persistent dataset/local engine, lineage, 100k+ rows/workers.
6. Scoped file search/parsers/artifacts/Excel-CSV-JSON-PDF.
7. Generic DB discovery/read-only SQL/fingerprint/profiles.
8. Generated logic/self-correction/workflow validation.
9. Web search/read/sources + legal/local workflow.
10. Multi-company batch/concurrency/provenance/drill-down.
11. Declarative UI.
12. Desktop control (disabled trước enforcement).
13. Communication (approval/verify, disabled mặc định).
14. Optional writes (dry-run/diff/approval/transaction/verify).
15. Hardening/performance/crash/migration/production gates.

Scaffold/mock không đồng nghĩa executor PASS. Sau từng phase điền kết quả thật trước khi tiếp tục.
