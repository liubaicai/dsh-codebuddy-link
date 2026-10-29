# Changelog

## 0.3.22

- Accept validated non-executing ACP session metadata after prompt completion regardless of stream grouping, while rejecting late execution, mismatched sessions and duplicate replies. Preserve all message text instead of assuming a new message ID replaces the answer.
- Preserve the primary error and its authentication/abort/timeout classification when cleanup also fails; retain success-path descendant capture and fail-closed cleanup. Bound repeated answer previews without truncating final text.
- Serialize explicit settings actions behind polling rather than silently dropping clicks. Keep stale-response, dirty-draft, disposal and mutation-exclusivity guards.
- Keep recovery diagnostics available for invalid persisted settings while disabling provider/delegation execution and writes; preserve the original file for explicit repair and restart. Keep update whitelists strict.
- Share bounded request/returned model-ID validation across configuration, discovery, runtime and UI. Try valid Windows PATH launcher alternatives without silently substituting explicitly pinned paths or using a shell.
- Verify published adapter and offline ACP behavior instead of legacy parser-only smoke. Centralize the unchanged compatibility User-Agent, clarify native-tool credential access, and correct the English plugin title.

## 0.3.21

- Add browser-authorized multi-account storage, metadata-only management, legacy credential migration, fixed selection and session-affine round-robin pools. Enforce one live call per account, bounded cancellable queues and fresh credentials before spawn. Never silently fall back after account management starts, switch identity mid-call, or replay failed work.
- Isolate account quota/catalog diagnostics, mark confirmed authentication failures for reauthorization, and protect freshly rotated credentials from stale failures. Catalog discovery remains distinct from model entitlement.
- Compact settings into account cards, model chips, shared model/delegation controls, hover/focus safety help and collapsed run history. Remove JSON import endpoints and manual model/runtime/tools controls from the UI; retain administrator configuration.
- Add storage/OAuth, scheduler, runtime/HTTP and UI regressions. Cover cancellation through process cleanup, credential rotation, managed-mode transitions and active-session affinity. Include both queue budgets in the delegation host timeout.

## 0.3.20

- Connect autonomous execution through ACP stdio (`initialize`, `session/new`, `session/prompt`, `session/update`, `session/cancel`) instead of print streams. Use a fresh session with each DSH history projection, bind both process/session cwd, never auto-fallback/replay, deny residual permission prompts, and validate bounded JSON-RPC messages with cancellation/process-tree cleanup.
- Make ACP the fixed provider transport, removing the execution-mode switch. Ignore retired `executionMode` config/environment values and strip the saved key on the next settings save; tolerate stale UI patches without restoring bridge mode. Keep CodeBuddy's native system prompt and default tools, append host task context, and return progress plus the final answer without parsing DSH tool envelopes or replaying native operations. Require an explicit/session workspace; housekeeping remains tool-free print mode.
- Keep `dangerouslySkipPermissions` as an independent, default-off setting: pass `--dangerously-skip-permissions` only for ACP provider calls, without a conflicting permission mode. Independent `codebuddy_ask` retains its existing permissions. CLI HIGH/CRITICAL restrictions can still apply.
- Update UI/API/status and documentation for fixed ACP, sandbox and cancellation limitations; add config migration, prompt, process-argv, final-result, error/cancellation and settings regressions.

## 0.3.19

- Normalize valid historical tool arguments to objects in prompt projections, without rewriting stored history. Put the serialization-only transport contract at system priority and request independent NDJSON records rather than one deeply nested batch envelope. Preserve legacy response formats and atomic fail-closed parsing; no JSON repair, automatic retries or schema-mode billing changes.
- Include complete parse-failure diagnostics in the terminal error message as well as text chunks, because DSH may store failed text streams only as hidden attempts. Keep cancellation/transport errors and metadata-only settings history unchanged.
- Add multi-cycle prompt, policy-preservation, complex-script record and missing/extra-brace atomic-failure regressions.

## 0.3.18

- Show the complete model reply as a fenced diagnostic when provider response parsing fails, while retaining an error finish and executing no tool calls. Preserve final-result-only replies, usage and failed runtime status; keep raw replies out of settings diagnostics. No automatic repair, retry or model calls.
- Prefer object-valued tool arguments in the prompt/schema to avoid nested JSON string escaping; keep valid legacy strings compatible and identify the failing tool-call ordinal for string parsing errors.
- Fix JSON fence termination on Unicode line separators inside valid JSON strings. Add a regression from the reported step-5-preview response with a stray bracket in its third tool's arguments.

## 0.3.17

- Refresh the account automatically when opening settings, then fetch the model catalog only when the fresh account status is available. Manual account refresh follows the same sequence, without adding external requests to the local status polling loop or overwriting unsaved settings.
- Keep only the five most recently queued call diagnostics across runtime, HTTP and UI; place the history below Save Settings. Removing an old diagnostic does not cancel its call or change FIFO scheduling.
- Add regressions for sequential refresh, invalid accounts, stale/unmounted requests, draft preservation, history ordering/limits and scheduling after diagnostic eviction.

## 0.3.16

- Add in-memory, metadata-only call diagnostics: requested/returned model, requested effort, declared DSH context budget and source, CLI-reported credits/USD cost, timestamps and terminal categories. Unknown values remain unknown; context override and confirmed server reasoning are never claimed. Restrict model identifiers and keep prompts, responses, credentials, raw errors and paths out of run snapshots.
- Unify provider and `codebuddy_ask` effort precedence with a persisted `reasoningEffort` default and per-call override. Explicit `auto` omits `--effort`; invalid values fail rather than silently falling back.
- Share a bounded process-local FIFO between both entrypoints: configurable concurrency (default 2), separate queue deadline, queued cancellation without spawn, and slot release after CLI cleanup. Live concurrency increases wake queued calls without killing existing processes on decreases.
- Add waiting/responding states and configurable no-progress warnings, plus settings-page local status polling that preserves edits and does not poll external credits/OAuth. Preserve active calls plus 50 terminal records; provide `/codebuddy runs`. No automatic retries, model switching, privilege expansion, persistent CLI sessions or diagnostic log files.
- Add protocol, runtime, HTTP/client and actual fake-CLI entrypoint integration regressions covering effort arguments, queue sharing, cancellation, execution timeout, live settings, metadata privacy and active-record retention.

## 0.3.15

- Prepare public GitHub distribution with committed build artifacts, HTTPS Git/tag installation instructions, repository metadata, and a dependency-free prepack verification step. Git installations work without lifecycle scripts or TypeScript build dependencies.
- Add Linux/Windows CI on Node 22.18 and 24, source/dist consistency checks, Git-install smoke coverage, and tag-triggered GitHub Releases with a tested archive and SHA-256 checksum.
- Replace private troubleshooting narrative and local paths in regression fixtures with synthetic equivalents while preserving the failure formats. Exclude local diagnostic files and credentials from version control.

## 0.3.14

- Replace fixture-specific envelope extraction with one anchored response normalizer: DSH, OpenAI tool_calls/function_call/Responses output, Anthropic tool_use content, Gemini functionCall parts and single-candidate wrappers, standalone DSML and Hermes/Qwen tool_call JSON tags. Support object arguments, common aliases, arrays, segmented JSON, per-part fences, BOM/CRLF and one extra JSON encoding.
- Preserve opaque text/argument strings, including literal fence/tag delimiters. Recognize provider thinking metadata without showing it as final text. Keep CLI tools disabled and validate the complete response before any DSH calls are emitted.
- Stop extracting executable JSON from explanatory prose. Reject competing call channels, refusal combined with calls, duplicate keys/IDs, malformed suffixes, non-object arguments, unknown tools, incomplete completion statuses and multi-candidate alternatives. Apply explicit aggregate/depth limits and strict JSON validation to DSML parameters too; reject in-memory argument hooks and non-JSON values.
- Add a format × transport × argument matrix, fragmented/result/structuredOutput adapter coverage, and adversarial audit regressions alongside all captured failures. Document supported formats and deliberate exclusions; no heuristic JSON repair or guarantee for future unknown protocols.

## 0.3.13

- Fix `Invalid CodeBuddy response envelope` for captured DeepSeek output split into adjacent `{"text":"..."}` and `{"toolCalls":[...]}` documents. Read every document rather than accepting only the first; normalize text-only/calls-only parts in order and preserve argument strings unchanged.
- Validate all documents before emitting any text or tool calls. Reject incomplete/unknown suffix documents, ambiguous multi-document prose/fences, invalid arguments, and more than 32 calls in aggregate. Keep standalone DSML and plain-final support, with CLI tools disabled and execution owned by DSH.
- Add the original failed reply, fragmented-stream/result-only adapter replays, and regression coverage for broken trailing calls and aggregate limits. Full suite: 110 tests pass. This verifies captured outputs; it does not guarantee every future model serialization.

## 0.3.12

- Fix `CodeBuddy did not return valid structured JSON for DSH tools` when the model answers in plain natural language after tool results instead of wrapping the final reply in JSON. A captured deepseek-v4.1-flash final answer (diagnosis plus a question, no tool use) now streams verbatim. Fallback stays conservative: empty replies, unbalanced JSON fragments, unknown call formats, DSML markers embedded in prose, and envelope-like documents (`tool_calls`, `function_call`, arrays) still fail loudly instead of being shown as fake successful answers.

## 0.3.11

- Fix `CodeBuddy did not return valid structured JSON for DSH tools` after tool results on DeepSeek: a captured deepseek-v4.1-flash response contained a complete native DSML calls document, not JSON. Decode this standalone format into the same validated DSH tool-call envelope. Preserve string payloads exactly and parse non-string parameters as JSON; reject unknown tools, incomplete/duplicate parameters, mixed prose, trailing data, and more than 32 calls. CLI tools remain disabled, and DSH retains permission and execution control.
- Add the captured two-call response as a regression fixture, parser rejection tests, and adapter replay coverage. This verifies the recorded failure; other unrecognized output formats still fail closed.

## 0.3.10

- Stop using the CLI's `--json-schema` structured mode for tool calls. Measured on CLI 2.177.1 with an identical ~6.5K-token prompt: `--json-schema` billed 27K input tokens (4-8x inflation — a real session's 34K-token surface was billed as 315K), took ~30s instead of ~8s, and intermittently refused to use its own internal StructuredOutput tool. The JSON reply envelope is now requested via the prompt and parsed tolerantly (handles markdown fences and surrounding prose), giving plain-mode speed and cost.
- Report honest per-model context windows: model discovery now enriches the catalog from the public models.dev registry (`https://models.dev/api.json`, fetched anonymously with no credentials; offline it uses a bundled snapshot checked 2026-10-28). Windows persist per model (e.g. hy3 = 256K), so the session 上下文 display reflects the real model window instead of the 128K default; unknown models keep the configured fallback.

## 0.3.9

- Authenticate CLI model calls with the plugin's saved credential: every CLI child now receives `CODEBUDDY_AUTH_TOKEN`, which the official CLI checks before its own stored login. Chats work without a separate `codebuddy login` even when the CLI's local login is missing or expired; without a plugin credential the CLI keeps using its own login. Verified end-to-end in the real desktop environment (Electron host, structured tool mode): a previously-hanging configuration now returns a successful reply.

## 0.3.8

- Fix chats still hanging at 深度求索中 after the spawn fix: when the API call fails (e.g. expired login) in `--json-schema` structured mode, CLI 2.177.1 relays the status line as the whole assistant message ("401 Unauthorized") and then never emits a result row and never exits. The protocol now fails fast with the actionable error (run `codebuddy login`) as soon as an assistant message consists solely of a bare HTTP status line, instead of streaming it as text and waiting for the 10-minute timeout.

## 0.3.7

- Fix model calls hanging forever (深度求索中 without any response) in the DSH desktop app: when the host is an Electron app, `process.execPath` is the GUI binary and spawning it launched a second GUI instance that never answered. Children now run with `ELECTRON_RUN_AS_NODE=1`, making the Electron binary behave as plain Node.
- Expose the CLI's reasoning effort levels (`minimal`/`low`/`medium`/`high`/`xhigh`/`max`/`ultracode`, verified against CLI 2.177.1) so DSH renders its 思考等级 picker; the selected level is forwarded to `--effort`.
- Authentication failures (expired CLI login) now surface as an actionable error telling you to run `codebuddy login` in a terminal instead of a generic failure.

## 0.3.6

- Fix authenticated China `/v3/config` requests failing with HTTP 400 (code 12403 "check ua, get coding copilot version error"): send the official CLI User-Agent (`CLI/2.63.2 CodeBuddy/2.63.2`) that the server's version check accepts, matching the credits client.

## 0.3.5

- Display account credit amounts with exactly two decimal places while preserving calculation precision.
- Merge China and international configuration candidates with installed official CLI models rather than stopping at the first successful source. China credentials are never sent to the international endpoint.
- Explicitly report incomplete international discovery; candidate lists do not prove account entitlements.

## 0.3.4

- Use DSH host theme aliases instead of light-only color fallbacks; remove heading margins inside centered action rows.
- Match ai-usage-board resource envelopes and quota field priority, sum independent resource packages, and stop pagination on a short page or a confirmed total.
- Recognize the official CLI's current bin/codebuddy launcher and discover standard npm/NVM installs when desktop PATH lacks the launcher.

## 0.3.3

- Fix OAuth start validation to accept the actual remaining lifetime (1–600 seconds), with delayed/expired response tests.
- Style all settings controls consistently with semantic theme colors and compact typography.
- Add explicit model discovery through official CLI configuration, falling back to the installed official package's model candidates without claiming account entitlement.
- Let users select discovered model IDs and save them; keep manual entry under advanced settings.

## 0.3.2

- Fix desktop/web startup failure (`Unexpected token 'export'`): emit the client as a DSH ModuleLoader factory classic script rather than native ESM. The host entry remains ESM.
- Run client regression tests against the built artifact through the ModuleLoader factory contract, instead of separately transpiling source in tests.

## 0.3.1

- Add the user-provided WorkBuddy icon and localized plugin display metadata: Codebuddy 桥接.
- Clarify that model calls use the official CLI without reverse-engineering model APIs, with shared WorkBuddy account credits.
- Keep the technical package identity unchanged for existing installations.

## 0.3.0

- Add settings-page WorkBuddy browser authorization and strict JSON credential import, based on protocol references in ai-usage-board.
- Store only access token and uid in a separate restricted server-side file; never return tokens to the browser or modify official CLI login state.
- Add expiring server-owned OAuth flows, manual result checks, cancellation, rate limiting and stale-result guards.
- Add explicit credential clearing and retain administrator file fallback; invalidate cached balances after account changes.
- Add authentication, HTTP security, persistence and client regression tests. Real OAuth/credit success and running-GUI visual acceptance still require user login.

## 0.2.0

- Add native DSH settings and plugin-detail panels.
- Persist model visibility, default model, delegation permission mode and tools atomically.
- Notify the DSH model picker on settings changes; reject disabled model invocations.
- Add guarded JSON HTTP routes and client/settings integration tests.
- Add an experimental read-only CN shared-credit API client using an explicitly configured local credentials file; never refresh/write login state or expose tokens to the browser. Live successful account validation remains outstanding; unknown values are never shown as zero.
- Coalesce concurrent refreshes, sanitize failures, and isolate plugin tests from user settings.
- This release has not been installed or visually verified in the running DSH instance.

## 0.1.0

- Add CodeBuddy CLI LlmAdapter, model listing, full-history prompting and DSH-owned structured tool calls.
- Add standalone codebuddy_ask and /codebuddy status|models|help.
- Add stream-json protocol normalization, Unicode buffering, usage handling and explicit authentication failures.
- Add shell-free Windows npm launcher support, cancellation, timeout and process-tree cleanup.
- Disable CLI tools by default; never enable them for the model provider.
- Add automated adapter/protocol/process tests and installation documentation.
- Known validation gap: local CodeBuddy 2.177.1 returned authentication 401; successful live model and DSH tool-loop acceptance requires a working CodeBuddy login.
