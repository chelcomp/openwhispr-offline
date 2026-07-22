# EktosWhispr — Especificação Técnica Completa para Recriação

> **Propósito deste documento**: consolidar uma leitura completa do repositório (420 arquivos, ~89.000 linhas) em uma única referência técnica detalhada o suficiente para que outra IA (ou engenheiro) recrie o app do zero — funcionalidades, regras de negócio, fluxos de dados, canais IPC, schema de banco de dados, protocolos de binários nativos, e pipeline de build/empacotamento.
>
> **Metodologia**: 7 agentes de pesquisa independentes leram o código-fonte real (não apenas a documentação existente) e produziram relatórios por subsistema. Os relatórios foram concatenados aqui com edição mínima. Onde o código diverge do `CLAUDE.md` (o documento de referência do próprio projeto) ou do que seria esperado, isso está marcado explicitamente com **⚠️ DIVERGÊNCIA**.
>
> **Nomenclatura**: nomes de arquivos, funções, variáveis, canais IPC e identificadores técnicos foram preservados em inglês/original. A prosa explicativa está em português.

---

## Índice

0. [Divergências importantes vs. CLAUDE.md (leia primeiro)](#0-divergências-importantes)
1. [Main Process, IPC e Infraestrutura](#1-main-process-ipc-e-infraestrutura)
2. [Pipeline de Áudio e Transcrição](#2-pipeline-de-áudio-e-transcrição)
3. [Hotkeys, Plataforma e Detecção de Reuniões](#3-hotkeys-plataforma-e-detecção-de-reuniões)
4. [Banco de Dados, Notas e Busca](#4-banco-de-dados-notas-e-busca)
5. [IA / Reasoning / Agente](#5-ia--reasoning--agente)
6. [Interface React (UI)](#6-interface-react-ui)
7. [Build, Empacotamento e Recursos Nativos](#7-build-empacotamento-e-recursos-nativos)

---

## 0. Divergências Importantes vs. CLAUDE.md

Estas são as discrepâncias mais relevantes encontradas entre a documentação de referência do projeto (`CLAUDE.md`) e o comportamento real do código, descobertas durante a pesquisa. Uma reconstrução fiel deve seguir o **código real**, não a descrição abaixo do que o CLAUDE.md afirma.

> **Status (revisão de documentação pós-remoção do cloud dead code):** os itens abaixo foram corrigidos no `CLAUDE.md` — o texto do CLAUDE.md agora reflete o código real descrito aqui. Os itens permanecem documentados por completo (evidência + arquivos envolvidos) para referência histórica e para o caso de regressão futura; se o CLAUDE.md voltar a divergir de algum destes pontos, é um bug de documentação.

1. 🗑️ **Removido.** Itens 1–3 originalmente documentavam divergências do subsistema de busca semântica local (sidecar Qdrant, embeddings MiniLM via ONNX, fluxo híbrido FTS5+vetor com RRF). Esse subsistema inteiro foi **removido** do código (ver `docs/specs/remove-qdrant-dependency.md`): não há mais sidecar Qdrant, não há mais embeddings locais/`localEmbeddings.js`/`vectorIndex.js`, e `search_notes`/busca de conversas do agente agora usam **apenas FTS5** (keyword puro, sem RRF nem fallback semântico). Mantido aqui como referência histórica de que essa arquitetura existiu; ver §4 para o estado atual.
2. ✅ **Corrigido.** Não existe um provider de IA chamado "ektoswhispr". O conceito de "EktosWhispr Cloud" (backend próprio hospedado) está desativado/em remoção (a branch atual chama-se `chore/remove-dead-cloud-code`). Todos os seletores `selectIsCloud*Mode` retornam `false` hardcoded, e `streamFromIPC` lança erro `"Cloud agent streaming is not available in this version"`. Os providers reais são 7: `openai`/`custom`/`openrouter` (1 handler), `anthropic`, `gemini`, `groq`, `local`, `bedrock`/`azure`/`vertex` (1 handler "enterprise"), `lan`. Ver §5. (Ver também a remoção de `agent-skills/ektoswhispr-api/` e a limpeza de `docs/network-allowlist.md`, que documentavam esse mesmo backend cloud inexistente.)
3. ✅ **Corrigido.** Não existe `src/config/aiProvidersConfig.ts`. A derivação de "AI_MODES" mencionada no CLAUDE.md é, na verdade, `buildReasoningProviders()` em `src/models/ModelRegistry.ts`. Ver §5.
4. ✅ **Corrigido.** Google Calendar foi removido do código atual. `src/helpers/googleCalendarManager.js`/`googleCalendarOAuth.js` não existem mais nesta branch. No antigo `meetingDetectionEngine.js` (hoje `manualMeetingLauncher.js`, com toda a máquina de detecção/notificação removida — ver §3.4), `imminentEvent` era hardcoded para `null`. A seção do CLAUDE.md sobre "Calendar Sync Resilience" descrevia uma arquitetura histórica já removida. Ver §3. **Atualização**: os remanescentes dessa remoção (`joinCalendarMeeting()`/`getActiveEvents()`/`getCalendarEventById()` no antigo `meetingDetectionEngine.js`/`database.js`, os 20 métodos mortos de `database.js` relacionados a Google Calendar, as tabelas `google_calendar_tokens`/`google_calendars`/`calendar_events`, e as strings órfãs `get_calendar_events`/`integrations.*` em prompts/ícones/locales) foram removidos por completo (`docs/specs/remove-dead-google-calendar-code.md`). Não há mais nenhum código, schema, ou string relacionado a Google Calendar no repositório.
5. ✅ **Corrigido.** Onboarding não tem 8 passos fixos nem passo de "agent naming". O wizard atual é dinâmico (passo `localModel` é condicional). Não há passo dedicado para nomear o agente — isso só existe em Settings hoje, com default `"EktosWhispr"`. O passo `meeting` (e `MeetingSetupStep.tsx`) existia no código, desativado via flag hardcoded `showMeetingStep = false`, e foi **removido** junto com a detecção automática de reuniões (ver §3.4). Ver §6.
6. ✅ **Corrigido.** Chaves de `localStorage` divergiam do CLAUDE.md: a chave real do hotkey é `dictationKey` (não `hotkey`); a flag de onboarding concluído é `onboardingCompleted` (não `hasCompletedOnboarding`); idioma de UI e idioma de transcrição são chaves **separadas** (`uiLanguage` e `preferredLanguage`), não uma única chave `language`. Ver §6 para a tabela completa.
7. ✅ **Corrigido.** `SECRET_KEYS` em `environment.js` tem 16 chaves, não 12. Além das 7 BYOK + 5 enterprise citadas no CLAUDE.md, há mais 4: `ASSEMBLYAI_API_KEY`, `DEEPGRAM_API_KEY`, `CUSTOM_TRANSCRIPTION_API_KEY`, `CUSTOM_CLEANUP_API_KEY`. Ver §1 e §7.
8. ✅ **Corrigido.** Node pinado é 26, não 24. `.nvmrc`/`package.json` (`engines.node >= 26`) apontam para Node 26; o CLAUDE.md mencionava Node 24 (desatualizado). Ver §7.
9. ✅ **Corrigido.** Parakeet/NVIDIA sempre tenta CUDA quando há GPU, sem toggle manual — diferente do Whisper, que respeita o botão CPU/GPU do usuário (`WHISPER_GPU_MODE`). Não há variável equivalente para forçar CPU no Parakeet; é uma decisão de design explícita no código-fonte. Ver §2.
10. ✅ **Corrigido.** Um `whisper-server` ausente (`resources/bin/`) costumava ser um beco sem saída: `WhisperManager.transcribeLocalWhisper()` lançava um erro sem `.code`, o `catch` de `transcribe-local-whisper` em `ipcHandlers.js` não reconhecia a mensagem (nenhum branch de substring casava), e o erro chegava ao renderer sem estrutura — a única recuperação era o script de dev `npm run download:whisper-cpp`. Agora: o erro carrega `err.code = "WHISPER_SERVER_BINARY_MISSING"` desde o throw site (`whisperServer.js`/`whisper.js`), passa por uma função pura de classificação extraída (`src/helpers/whisperErrorClassifier.js`'s `classifyLocalWhisperError()`), sobrevive aos dois pontos de re-wrap em `audioManager.js`, e chega ao toast de erro no `useAudioRecording.js` com um botão de ação "Download" que baixa e instala o binário em tempo de execução (`src/helpers/whisperBinaryInstaller.js`, IPC `download-whisper-server-binary`) em `userData/bin/` — local que `WhisperServerManager.getServerBinaryPath()` já verifica (mesmo padrão do binário CUDA). Escopo apenas para `whisper-server`; `llama-server` tem a mesma lacuna e é um follow-up documentado, não implementado. Ver `docs/specs/whisper-binary-missing-ux.md`.

---

## 1. Main Process, IPC e Infraestrutura

### 1.1 Visão Geral

O processo principal do EktosWhispr é responsável por: bootstrap da aplicação, criação/gestão de janelas, registro de todos os canais IPC, gestão de segredos/variáveis de ambiente, hotkeys globais, tray/menu, arrasto de janela, ponte HTTP para o CLI, detecção de migração de bundle, e ciclo de vida de processos "sidecar" (llama-server, whisper-server, parakeet-server, diarização).

Arquivos cobertos nesta seção: `main.js` (raiz), `preload.js` (raiz), `src/helpers/ipcHandlers.js`, `src/helpers/windowManager.js`, `src/helpers/windowConfig.js`, `src/helpers/environment.js`, `src/helpers/tray.js`, `src/helpers/menuManager.js`, `src/helpers/dragManager.js`, `src/helpers/cliBridge.js`, `src/helpers/postMigrationDetector.js`, `src/helpers/sidecarRegistry.js`, `src/helpers/sidecarPidFile.js`, `src/helpers/sidecarReaper.js`, `src/helpers/devServerManager.js`.

### 1.2 `main.js` — Bootstrap e Ciclo de Vida

#### 1.2.1 Pré-inicialização

1. **Relançamento forçado para X11 em Wayland (KDE/GNOME)**: se `process.platform === "linux"`, `XDG_SESSION_TYPE === "wayland"` e o desktop é KDE/GNOME/Ubuntu/Unity/Cosmic, o processo se relança a si mesmo (`spawn(process.execPath, [...argv, "--ozone-platform=x11"], { detached: true })`) e sai imediatamente (`process.exit(0)`). Motivo: o Chromium escolhe o backend de display antes do JS rodar, então `app.commandLine.appendSwitch` seria tarde demais.
2. Import do Electron (`app, desktopCapturer, globalShortcut, BrowserWindow, dialog, ipcMain, net, session, systemPreferences`).
3. `dotenv.config({ path: path.join(__dirname, ".env") })` — carrega `.env` de desenvolvimento na raiz do repo.
4. **Merge de CA do sistema operacional na store TLS do Node** (`tls.setDefaultCACertificates`) — para que `ws`/`https.get` no processo principal confiem nas mesmas CAs corporativas que o Chromium já confia. Falha é apenas logada, não é fatal.

#### 1.2.2 Resolução de canal de aplicação (`APP_CHANNEL`)

- `VALID_CHANNELS = {"development","staging","production"}`.
- `resolveAppChannel()`: lê `EKTOSWHISPR_CHANNEL` ou `VITE_EKTOSWHISPR_CHANNEL`; se inválido/ausente, cai em `inferDefaultChannel()`:
  - retorna `"development"` se `NODE_ENV === "development"`, ou `process.defaultApp` for true, ou o executável for o binário puro do Electron.
  - caso contrário `"production"`.
- **`configureChannelUserDataPath()`**: se o canal **não** for `"production"`, `app.setPath("userData", <appData>/EktosWhispr-<channel>)` — isola completamente o `userData` (DB, `.env`, secure-keys, cache) de instâncias `staging`/`development` em relação à instalação de produção.

#### 1.2.3 Carregamento de `.env` do usuário

Após o `userData` ser resolvido, `dotenv.config({ path: path.join(app.getPath("userData"), ".env"), override: false })` é chamado **cedo**, antes do registro de hotkeys — necessário porque `DICTATION_KEY` precisa estar disponível antes do renderer carregar.

#### 1.2.4 Flags/ajustes de plataforma

- `app.commandLine.appendSwitch("js-flags", "--max-old-space-size=256")` — limita o heap V8 antigo por processo.
- Linux: `gtk-version=3`, `enable-transparent-visuals`, `disable-gpu-compositing` (evita flicker de janelas transparentes).
- Linux + Wayland: `enable-features=WaylandWindowDecorations` (fallback best-effort para dev; builds empacotados usam `scripts/afterPack.js` que força `--ozone-platform=x11`).
- Linux: `app.setDesktopName("ektos-whispr.desktop")` — permite que portais XDG (PipeWire) casem janelas com a entrada `.desktop`.
- Windows: `app.setAppUserModelId(...)` — `com.gizmolabs.ektoswhispr` (produção) ou `com.gizmolabs.ektoswhispr.<channel>`.

#### 1.2.5 Single Instance Lock

`app.requestSingleInstanceLock()`; se falhar, `app.exit(0)` imediatamente.

#### 1.2.6 Managers (import estático, instanciação tardia)

Classes importadas no topo mas só instanciadas dentro de `initializeCoreManagers()`/`startApp()`: `EnvironmentManager`, `WindowManager`, `DatabaseManager`, `ClipboardManager`, `WhisperManager`, `ParakeetManager`, `DiarizationManager`, `TrayManager`, `IPCHandlers`, `CliBridge`, `UpdateManager`, `GlobeKeyManager`, `DevServerManager`, `WindowsKeyManager`, `LinuxKeyManager`, `TextEditMonitor`, `WhisperCudaManager`, `AudioTapManager`, `LinuxPortalAudioManager`, `WindowsLoopbackAudioManager`, `MeetingAecManager`, `ManualMeetingLauncher`, `i18nMain`, `ensureYdotool`, `sidecarRegistry`, `reapStaleSidecars`, `TransformManager`. (`MeetingProcessDetector`/`AudioActivityDetector` não existem mais — ver §3.4.)

#### 1.2.7 `startApp()` — sequência de boot

```
reapStaleSidecars()
initializeCoreManagers()          // Fase 1
await environmentManager.init()   // carrega/migra segredos criptografados
registerSidecars()                // registra stop-functions no sidecarRegistry
```

1. **`reapStaleSidecars()`** — antes de qualquer coisa, lê `userData/sidecar-pids/*.pid` e mata (SIGTERM) qualquer processo órfão de uma execução anterior cujo binário ainda bate com `EXPECTED_BINARY_FRAGMENTS` (§1.9.3).
2. **`initializeCoreManagers()`** (Fase 1 — antes do conteúdo das janelas carregar):
   - `setupProductionPath()` — em macOS produção, injeta `/usr/local/bin`, `/opt/homebrew/bin`, `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin` em `PATH`.
   - `debugLogger.ensureFileLogging()`.
   - `environmentManager = new EnvironmentManager()` → aplica `UI_LANGUAGE` em `process.env`.
   - `windowManager = new WindowManager()`; `hotkeyManager = windowManager.hotkeyManager`.
   - Demais managers instanciados.
   - `ManualMeetingLauncher` criado com `windowManager` + `databaseManager` (sem detectores — não existe mais detecção automática, ver §3.4).
   - `UpdateManager` criado e ligado ao `windowManager`.
   - `WindowsKeyManager`, `LinuxKeyManager`, `TextEditMonitor`, `AudioTapManager`, `LinuxPortalAudioManager`, `WindowsLoopbackAudioManager` instanciados; `cleanupOrphanedLinuxRestoreToken()` remove um arquivo de token de portal órfão. `MeetingAecManager` instanciado.
   - `TransformManager` criado com `windowManager` + `clipboardManager`.
   - **`ipcHandlers = new IPCHandlers({...})`** — registra **todos** os canais IPC (construtor chama `setupHandlers()`); deve acontecer **antes** do conteúdo das janelas carregar.
3. **`await environmentManager.init()`** — dispara migração de segredos para storage criptografado (se ainda não migrado) e carrega todos os `SECRET_KEYS` para `process.env`.
4. **`registerSidecars()`** — registra funções de parada no `sidecarRegistry` para: `whisper`, `parakeet`, `diarization`, `llama`, `onnx`, `mic-mute-helper`.
5. Cache de estado no `windowManager`: `setActivationModeCache`, `setFloatingIconAutoHide`, `setPanelStartPosition` — lidos do `EnvironmentManager` (fonte de verdade em `.env`, espelhando o `localStorage` do renderer).
6. Handlers `ipcMain.on(...)` registrados diretamente em `startApp()`:
   - `"activation-mode-changed"` → cache + persiste.
   - `"floating-icon-auto-hide-changed"` → cache + persiste + reenvia para a janela principal.
   - `"start-minimized-changed"` → persiste.
   - `"panel-start-position-changed"` → reposiciona + persiste.
7. macOS: `app.setActivationPolicy("regular")`.
8. Dev mode: espera 500ms para o Vite dev server.
9. **Criação de janelas** (nesta ordem):
   - `postMigrationDetector.isReturningFromOldBundle()` decide se o modal de pós-migração é necessário.
   - `startMinimized = environmentManager.getStartMinimized() && !needsPostMigrationOnboarding`.
   - `await windowManager.createMainWindow()` — **sempre** criada.
   - Se `!startMinimized`: `await windowManager.createControlPanelWindow()`.
   - Janela do agente (chat overlay) é **lazy** — só criada na primeira ativação.
10. **Hotkeys de slot `agent` e `voiceAgent`**: callbacks registrados via `hotkeyManager.registerSlot(slot, hotkey, callback)` se houver hotkey salvo.
11. **Hotkey de slot `meeting`**: mesmo padrão; `ipcMain.handle("register-meeting-hotkey", ...)` registrado diretamente aqui (não em `ipcHandlers.js`).
12. **`initializeDeferredManagers()`** (Fase 2 — depois das janelas visíveis):
    - Pré-aquece cache de capacidade de loopback do Windows.
    - `ensureYdotool()` (Linux, non-fatal).
    - `clipboardManager.preWarmAccessibility()`.
    - `trayManager = new TrayManager()`.
    - `globeKeyManager = new GlobeKeyManager()`; erro → `dialog.showMessageBox` uma única vez.
13. `powerMonitor.on("resume", ...)` — agenda (`WHISPER_WAKE_REWARM_DELAY_MS = 3000`) `whisperManager.stopServer()` (não mais um reload — ver §14 abaixo/`docs/specs/on-demand-model-lifecycle.md` R9: sleep deixa o processo do whisper-server rodando com um contexto CUDA morto, então a ação correta é descarregar, não recarregar; o próximo hotkey de Dictation faz o cold-start normal via warm-up on-demand).
14. **Nenhum pré-aquecimento no startup** (revertido — ver `docs/specs/on-demand-model-lifecycle.md`, que superseder `docs/specs/transcription-engine-lifecycle.md`): `whisperManager.initializeAtStartup(...)`/`parakeetManager.initializeAtStartup(...)` continuam sendo chamados aqui, mas agora fazem apenas limpeza de downloads incompletos + log de dependências — nenhuma chamada a `serverManager.start()`. Os blocos que pré-aqueciam `llama-server` via `modelManagerBridge.prewarmServer(...)` (para `CLEANUP_PROVIDER`/`DICTATION_AGENT_PROVIDER === "local"`) foram removidos por completo. Todo carregamento de modelo (Whisper, Parakeet, llama-server) agora é on-demand: disparado no hotkey-down de Dictation/Meeting/Note Recording ou na seleção de arquivo do Upload (`audioManager.js`'s `warmupTranscriptionEngine()`/`warmupReasoningServer()`, `meetingRecordingStore.ts`, `UploadAudioView.tsx`), e cada engine descarrega sozinho após um timeout de inatividade configurável (`transcriptionIdleTimeoutMs` para Whisper/Parakeet, `llmIdleTimeoutMs` para llama-server — ambos padrão 5 minutos, limites 30s–60min, totalmente independentes).
    - Diarização: baixa modelos em background se ausentes (isso continua igual).
15. **Limpeza única de dados órfãos do Qdrant/embeddings** (`src/helpers/qdrantDataCleanup.js`, adicionada na remoção do subsistema — ver `docs/specs/remove-qdrant-dependency.md`): best-effort, não bloqueante, apaga `~/.cache/ektoswhispr/qdrant-data/` e `~/.cache/ektoswhispr/embedding-models/` uma única vez (sentinela `.qdrant-removed` em `userData`) para quem atualiza de uma versão que tinha o Qdrant instalado.
16–21. Tray, Update, handlers macOS de Globe key (push-to-talk, right-modifier, mouse buttons, accessibility check), handlers Windows/Linux de tecla nativa compartilhados entre slots.

#### 1.2.8 Eventos de aplicação (nível `app`)

| Evento | Comportamento |
|---|---|
| `second-instance` | Foca/restaura o painel de controle; força o `mainWindow` para o topo. |
| `whenReady().then(...)` | Delay 300ms no Linux; registra `setDisplayMediaRequestHandler` no Windows; chama `startApp()`. |
| `window-all-closed` | `app.quit()` exceto no macOS. |
| `browser-window-focus` | Reforça always-on-top só se a janela focada for `mainWindow`. |
| `activate` (macOS) | Recria janelas se necessário. |
| `before-quit` | Guardado por `isShuttingDown`. Se update pendente: teardown síncrono + shutdown sidecars sem `preventDefault`. Senão: `preventDefault`, `performSyncTeardown()`, aguarda shutdown, `app.exit(0)`. |

#### 1.2.9 `performSyncTeardown()`

Limpa, na ordem: timer de wake; `cliBridge`; janelas `agentWindow`/`transcriptionPreviewWindow`; `hotkeyManager.unregisterAll()`; `globeKeyManager`/`windowsKeyManager`/`linuxKeyManager`; `audioTapManager`/`linuxPortalAudioManager`/`windowsLoopbackAudioManager`/`meetingAecManager`; `textEditMonitor`; `updateManager`. (`ManualMeetingLauncher` não tem estado de teardown — a versão anterior, `MeetingDetectionEngine`, tinha `stop()` para os detectores removidos; não existe mais.)

### 1.3 `preload.js` — Superfície `window.electronAPI`

`contextBridge.exposeInMainWorld("electronAPI", {...})` com `contextIsolation: true`. Nenhum módulo local pode ser `require`ado em contexto sandboxed (`mainWindow`/`agentWindow` usam `sandbox: true`).

- **BYOK API keys**: gerado programaticamente a partir de `BYOK_KEY_BRIDGES`. Para cada entrada, expõe `getXxxKey()` e `saveXxxKey(key)`.
- **`registerListener(channel, handlerFactory)`**: helper genérico que registra `ipcRenderer.on` e devolve função de cleanup.

Categorias expostas (~55 grupos): ditado/janela, DB transcrições, áudio de transcrição, dicionário, snippets/backups, notas, pastas, espelho Markdown, ações (agent actions), arquivos de áudio, eventos de notas/ações/transcrições, chaves BYOK, clipboard/acessibilidade, Whisper local, servidor Whisper, GPU CUDA, seletor de modo GPU, Parakeet, diarização, mapeamento de falantes, controle de janela, backup completo, limpeza/hotkeys, updates, modelos LLM locais (GGUF), idioma UI, chaves enterprise, hotkey de ditação, sincronização de env, raciocínio (LLM), llama.cpp, backends Vulkan/CUDA, logging/debug, configurações de sistema, upload/transcrição BYOK, transcrição de reunião, ditado em tempo real, tecla Globe, eventos de hotkey/settings, acessibilidade, notificações, agente, preview de ditação, contatos, detecção de reuniões, notificação de update, transforms.

**Nota**: `agentWebSearch`/`agentOpenNote` estão expostos no preload mas **sem handler correspondente** em `ipcHandlers.js` — provavelmente API legada/morta (a busca web do agente é feita diretamente pelo renderer via `webSearchTool.ts`).

### 1.4 `src/helpers/ipcHandlers.js` — Registro Central de IPC

`IPCHandlers` é instanciada uma vez em `main.js`, recebendo todos os managers via injeção de dependência. O construtor:

- Guarda referências a todos os managers.
- `this.sessionId = crypto.randomUUID()`.
- Inicializa estado de streaming, captura de hotkey, auto-learn, lock de gravação, `AudioStorageManager`, config de VAD, config de diarização.
- `_setupTextEditMonitor()` — ouve `"text-edited"` para auto-aprendizado do dicionário (debounce 1500ms, compara texto colado com edição via `extractCorrections`).
- `_setupAudioCleanup()` — limpeza automática de áudio **apenas de ditado** (`AudioStorageManager.cleanupExpiredAudio()`) a cada 6h, lendo `environmentManager.getAudioRetentionDays()` (env var `AUDIO_RETENTION_DAYS`, persistida via IPC `get`/`save-audio-retention-days`) a cada execução — nunca um valor capturado uma única vez no boot. **`0` significa "excluir todo o áudio de ditado existente imediatamente"**, não "desativado" — é o valor padrão (fallback) quando `AUDIO_RETENTION_DAYS` nunca foi sincronizada (postura de privacidade por padrão: o armazenamento local de áudio é opt-in). Valores inválidos (negativos, `NaN`, `Infinity`) são tratados como erro e pulam a limpeza naquele ciclo (log de aviso), sem serem confundidos com `0`. Uma salvaguarda de ordenação de startup (`shouldRunImmediateCleanup()` em `audioCleanupPolicy.js`) pula apenas a primeira passagem imediata quando a chave nunca foi persistida (instalação nova ou primeira execução após upgrade) — **o processo principal nunca escreve `AUDIO_RETENTION_DAYS` sozinho aqui**, pois `_setupAudioCleanup()` roda no construtor de `IPCHandlers`, antes de qualquer janela (e portanto do `localStorage` do renderer) existir; auto-persistir o fallback `0` nesse ponto sobrescreveria silenciosamente a preferência real de um usuário existente (ex.: `30`, escolhida antes desta correção existir). Quem efetivamente estabelece o valor autoritativo pela primeira vez é a sincronização de startup do renderer (`initializeSettings()` em `settingsStore.ts`, via IPC `get-audio-retention-sync-state`): se o main já tem um valor genuinamente persistido, o renderer *puxa* esse valor (main autoritativo); caso contrário, o renderer *empurra* seu próprio valor atual (real ou o `0` padrão) para o main, estabelecendo-o como persistido — decisão pura em `src/helpers/audioRetentionSync.js::resolveAudioRetentionStartupSync()`. A partir daí todo tick (incluindo o imediato em reinicializações futuras) segue as regras normais. Decisões de validade/skip extraídas para `src/helpers/audioCleanupPolicy.js` (funções puras, testáveis via `node --test`). **O áudio de reuniões é permanentemente isento desta (ou de qualquer) expiração automática**, conforme as Premissas Inegociáveis do Produto §7 (Retenção de dados) do `CLAUDE.md` — é dado operacional, não coletado/efêmero, e só é excluído por ação explícita do usuário: ao apagar a nota (`deleteNoteInternal()` → `meetingAudioStorage.deleteAudio()`) ou pelo botão "Clear All Meeting Audio" em Configurações → Privacidade e Dados (IPC `delete-all-meeting-audio` → `meetingAudioStorage.deleteAllMeetingAudio()`, que também limpa a coluna `audio_path` das notas afetadas sem tocar em título/transcrição/conteúdo). A função `meetingAudioStorage.cleanupExpiredAudio()` que antes fazia essa purga automática foi removida do código; o uso de armazenamento de áudio de reuniões é exposto via IPC `get-meeting-audio-storage-usage` → `meetingAudioStorage.getStorageUsage()`.
- `windowManager.onControlPanelDestroyed` força saída do modo de captura de hotkey se o painel for destruído no meio da captura.
- `this.setupHandlers()` registra ~250 canais.

Métodos utilitários notáveis:
- **`_asyncMirrorWrite(note)`/`_asyncMirrorDelete(noteId)`** — espelham notas para Markdown em disco.
- **`broadcastToWindows(channel, payload)`** — envia para todas as janelas não destruídas.
- **`deleteNoteInternal(id)`/`deleteTranscriptionInternal(id)`** — lógica compartilhada entre IPC e `CliBridge`.
- **`_syncStartupEnv(setVars, clearVars)`** — aplica env vars só se houver mudança real.

#### 1.4.1 Tabela de Canais IPC (visão consolidada por categoria)

*(convenções: **invoke** = dois sentidos com retorno; **on/send** = um sentido; **push** = main→renderer sem invoke correspondente)*

**Controle de janela**: `window-minimize/maximize/close/is-maximized`, `snap-to-meeting-mode`, `restore-from-meeting-mode`, `hide-window`, `show-dictation-panel`, `force-stop-dictation`, `set-main-window-interactivity`, `set-notification-interactivity`, `resize-main-window`, `start-window-drag`/`stop-window-drag`.

**Segredos BYOK** (loop sobre 7 chaves): `get-<base>-key`, `save-<base>-key`.

**Transcrições**: `db-save-transcription`, `db-get-transcriptions`, `db-clear-transcriptions`, `db-delete-transcription`, `get-transcription-by-id`, `retry-transcription`, `update-transcription-text`.

**Áudio de transcrição**: `save-transcription-audio`, `get-audio-path`, `show-audio-in-folder`, `get-audio-buffer`, `delete-transcription-audio`, `get-audio-storage-usage`, `delete-all-audio`.

**Dicionário**: `auto-learn-changed` (on), `db-get/set-dictionary`, `db-get-pending-dictionary(-deletes)`, `db-get-dictionary-by-client-id`, `db-upsert-dictionary-from-cloud`, `db-mark-dictionary-synced`, `db-hard-delete-dictionary`, `db-clear-dictionary-cloud-id`, `db-broadcast-dictionary-updated`, `undo-learned-corrections`.

**Snippets**: mesmo padrão de sync do dicionário + `snippets-backup/restore`, `dictionary-restore`, `transforms-backup/restore`, `notes-backup/restore`.

**Notas**: `db-save-note` (broadcast `note-added`, mirror assíncrono), `db-get-note(s)`, `db-update-note` (broadcast `note-updated`, auto-rotula reunião 1:1 se `participants` mudou), `db-delete-note`, `db-search-notes` (FTS5 puro — único caminho de busca, ver §4), `db-update-note-cloud-id`.

**Pastas**: `db-get-folders`, `db-create-folder` (broadcast `folder-created`), `db-delete-folder`, `db-rename-folder`, `db-get-folder-note-counts`.

**Ações**: `db-get-actions/action`, `db-create/update/delete-action` (broadcasts correspondentes).

**Conversas do agente**: `db-create-agent-conversation`, `db-get-conversations-for-note`, `db-get-agent-conversation(s)`, `db-delete-agent-conversation`, `db-update-agent-conversation-title`, `db-add-agent-message`, `db-get-agent-messages`, `db-get-agent-conversations-with-preview`, `db-search-agent-conversations` (FTS5 puro — único caminho de busca, ver §4), `db-archive/unarchive-agent-conversation`.

**Sincronização com nuvem** (padrão repetido para note/folder/conversation/transcription): `db-get-pending-*`, `db-get-pending-*-deletes`, `db-get-*-by-client-id`, `db-upsert-*-from-cloud`, `db-mark-*-synced`, `db-hard-delete-*`.

**Exportação**: `export-note` (md/txt), `export-transcript` (txt/srt/json/md), `export-dictionary`.

**Arquivos de áudio**: `select-audio-file`, `get-file-size`, `transcribe-audio-file`.

**Paste/Clipboard/Mic**: `paste-text` (pipeline: detecta app alvo, aplica snippets filtrados por app, smart-spacing, `clipboardManager.pasteText`, monitoramento de auto-aprendizado), `set/get-mic-muted`, `warmup-mic-mute-helper`, `check/prompt-accessibility-permission`, `read/write-clipboard`, `check-paste-tools`, `get-last-target-app-name`.

**Áudio de reunião/retranscrição**: `get-note-audio`, `retranscribe-meeting` (chunks de 30s via FFmpeg, progresso via push `retranscribe-progress`).

**Whisper local**: `transcribe-local-whisper`, `check-whisper-installation`, `get-audio-diagnostics`, `download/check/list/delete-whisper-model(s)`, `cancel-whisper-download`, `check-ffmpeg-availability`, `whisper-server-start/stop/status`.

**GPU/CUDA (Whisper)**: `detect-gpu`, `list-gpus`, `get-gpu-mode-info`, `set-whisper-gpu-mode`, `set-llama-gpu-mode`, `set/get-gpu-device-index`, `get-cuda-whisper-status`, `download/cancel/delete-cuda-whisper-binary`.

**Parakeet**: `transcribe-local-parakeet`, `check-parakeet-installation`, `download/check/list/delete-parakeet-model(s)`, `cancel-parakeet-download`, `get-parakeet-diagnostics`, `parakeet-server-start/stop/status`, `get/enable/disable-cuda-parakeet`.

**Diarização**: `download-diarization-models`, `get-diarization-model-status`, `delete-diarization-models`, `cancel-diarization-download`.

**Backup/Cleanup**: `full-backup` (empacota DB + `.env` + settings em JSON base64), `full-restore` (substitui DB/`.env`, relança app), `cleanup-app` (apaga tudo — modelos, áudio, DB, `.env`, cookies, localStorage).

**Hotkeys**: `update-hotkey`, `set-hotkey-listening-mode` (entra/sai do modo de captura, desregistra tudo), `get-hotkey-mode-info`, `get-hyprland-config-status`, `register/unregister-cancel-hotkey`, `register-meeting-hotkey` (em `main.js`), `update-agent-hotkey`/`update-voice-agent-hotkey`, `get/save-agent-key`, `get-voice-agent-key`.

**Sistema**: `open-external` (só http/https/mailto), `get/set-auto-start-enabled`, `open-control-panel` (on), `open-microphone/sound-input/accessibility/system-audio-settings`, `toggle/pause/resume-media-playback`, `request/check-microphone-access`, `check/request-system-audio-access`, `open-whisper-models-folder`, `get-ydotool-status`, `get-debug-state`/`set-debug-logging`/`open-logs-folder`, `get-log-level`/`app-log`.

**Modelos LLM locais**: `model-get-all`, `model-check`, `model-download`, `model-delete(-all)`, `model-cancel-download`, `model-check-runtime`.

**Enterprise/custom keys**: get/save para custom transcription/cleanup, Bedrock (região/profile/access-key/secret/session-token), Azure (endpoint/api-key/deployment/api-version), Vertex (project/location/api-key), `test-enterprise-connection`, `enterprise-stream-start/cancel` (partes via push `enterprise-stream-part`), `bedrock-list-models`.

**Ditação/idioma/env**: `get/save-dictation-key`, `get-active-dictation-key`, `get-effective-default-hotkey`, `get/save-activation-mode`, `get-start-minimized`, `get/save/set-ui-language`, `save-all-keys-to-env`, `sync-startup-preferences` (ponto central de sincronização localStorage → `.env`).

**Reasoning**: `process-local-reasoning`, `check-local-reasoning-available`, `process-enterprise-reasoning`.

**llama.cpp**: `llama-cpp-check/install/uninstall`, `llama-server-start/stop/status`, `llama-gpu-reset`, `detect-vulkan-gpu`, `get/download/cancel/delete-llama-vulkan-*`, `get/download/cancel/delete-llama-cuda-*`.

**Agente (overlay)**: `toggle-agent-overlay`, `hide-agent-overlay`, `resize-agent-window` (animação 250ms), `get/set-agent-window-bounds`, `acquire/release-recording-lock`.

**Contatos**: `search-contacts`, `upsert-contact`, `get-md5-hash`.

**Transcrição de reunião (streaming dual-channel)**: `meeting-transcription-prepare/start/send(on)/stop/cancel`; push: `meeting-transcription-segment`, `meeting-speaker-identified`, `meeting-speakers-merged`, `meeting-transcription-error`.

**Notificações e navegação de reunião** (sem detecção automática — ver §3.4): `sync-notification-preferences`, `meeting-set-speaker-diarization-enabled`, `whisper-vad-get/set-config`, `meeting-set-session-speaker-config`, `get-pending-meeting-note-navigation`; push: `meeting-note-navigation-pending`, `navigate-to-note`.

**Notificação de update**: `get-update-notification-data`, `update-notification-ready`, `update-notification-respond`; push `update-notification-data`.

**Espelho Markdown**: `note-files-set-enabled` (liga/desliga + reconstrói tudo), `note-files-set-path`, `note-files-rebuild`, `note-files-get-default-path`, `show-note-file`/`show-folder-in-explorer`, `note-files-pick-folder`.

**Falantes**: `get/remove-speaker-mapping(s)`, `set-speaker-mapping`, `get-speaker-profiles`, `attach-speaker-email`, `save-note-speaker-embeddings`.

**Ditado em tempo real**: `dictation-realtime-warmup/start/send(on)/stop`; push: `dictation-realtime-partial/final/error/session-end`.

**Preview de ditação**: `start-dictation-preview`, `dictation-preview-audio` (on), `dismiss/hide-dictation-preview`, `complete-dictation-preview`, `update-cleanup-preview`, `resize-transcription-preview-window`, `stop-dictation-preview`; push: `preview-text/append/hold/result/cleanup-update/hide`. **Handshake de prontidão do renderer**: como `loadFile`/`loadURL` resolvem em `did-finish-load` — antes do React montar `TranscriptionPreviewOverlay` e registrar seus listeners `onPreview*` — `windowManager.js` não envia esses seis eventos `preview-*` direto via `webContents.send`; em vez disso, `TranscriptionPreviewOverlay.tsx` chama `window.electronAPI.notifyTranscriptionPreviewReady()` (→ `ipcMain.on("transcription-preview-ready", ...)`) uma vez, logo após registrar seus listeners no mount. `windowManager.js` mantém `_transcriptionPreviewReady`/`_transcriptionPreviewPendingSends` por instância de janela (reiniciados a cada `BrowserWindow` novo e no evento `"closed"`), enfileirando qualquer envio `preview-*` até o sinal de prontidão chegar (ou até um timeout de 3000ms — `TRANSCRIPTION_PREVIEW_READY_TIMEOUT_MS` — esgotar como fallback), via o helper privado `_sendToPreviewWindow()`. Um sinal de prontidão vindo de uma instância de janela já destruída é ignorado (`event.sender` é validado contra a janela atual). Ver `docs/specs/transcription-preview-window-ready-race.md`.

**Transforms**: `sync-transforms`, `transform-result`; push: `transform-activated`, `run-transform` (o LLM call em si roda no renderer, não no main).

### 1.5 Arquitetura de Janelas (`windowManager.js` + `windowConfig.js`)

| Janela | Propósito |
|---|---|
| **`mainWindow`** | Overlay flutuante minimalista de ditado, sempre criado no boot. |
| **`controlPanelWindow`** | Settings, histórico, gestão de modelos — janela "normal". |
| **`agentWindow`** | Overlay do agente/chat — criado **lazy**, destruído (não escondido) ao fechar. |
| **`notificationWindow`** | Toast de detecção de reunião, auto-dismiss 30s. |
| **`updateNotificationWindow`** | Toast de update disponível, auto-dismiss 5s (não-persistente) ou dismiss persistente. |
| **`transcriptionPreviewWindow`** | Painel de preview de streaming ao lado do overlay principal. |

**`MAIN_WINDOW_CONFIG`**: `96×96` (redimensionável em runtime para `240×280`/`400×500`); `frame:false, transparent:true, alwaysOnTop:true, resizable:false, show:false, skipTaskbar:true, focusable:false, hasShadow:false, fullScreenable:false, acceptsFirstMouse:true`; `visibleOnAllWorkspaces: process.platform !== "win32"`; `type`: `"panel"` (macOS), `"normal"` (GNOME/KDE Wayland) ou `"toolbar"` (Linux) ou `"normal"` (Windows). `sandbox:true`. No Windows, **sempre** interativo (click-through pouco confiável nesse overlay); demais plataformas usam `setIgnoreMouseEvents`.

**`CONTROL_PANEL_CONFIG`**: `1200×800`; `frame:false`; macOS `titleBarStyle:"hiddenInset"`; `sandbox:false`, **`webSecurity:false`** (necessário para `fetch` cross-origin a APIs de LLM a partir de `file://`). Intercepta `will-navigate`/`setWindowOpenHandler` (bloqueia navegação externa, abre no browser do SO). Timer de segurança: força `show()` em 10s se `ready-to-show` não disparar. `render-process-gone` → recarrega após 1s. Ao fechar: **destrói** (não esconde) para liberar memória.

**`AGENT_OVERLAY_CONFIG`**: `420×300` inicial, `minWidth:360/minHeight:200`, `maxWidth:800/maxHeight:10000`; `sandbox:false, webSecurity:false, spellcheck:false`. `resizeAgentWindow` anima com easing quadrático (250ms). `hideAgentOverlay()` destrói a janela.

**Notificação/preview**: `frame:false, transparent:true, alwaysOnTop:true, skipTaskbar:true, resizable:false, focusable:false, hasShadow:false, show:false`. Notificação de reunião tem fallback de 3s (força mostrar) e auto-dismiss de 30s. Preview de transcrição posicionado ao lado do `mainWindow`, escolhendo o lado com mais espaço.

**Push-to-talk**: compound (macOS) espera `MIN_HOLD_DURATION_MS=150ms` antes de começar a gravar; Windows análogo. `reconcileNativeKeyListeners()` recalcula quais teclas os listeners nativos devem observar (no-op se usando D-Bus nativo GNOME/Hyprland/KDE, para evitar disparo duplo).

### 1.6 `EnvironmentManager` (`src/helpers/environment.js`)

#### 1.6.1 Carregamento (ordem de precedência)
1. `userData/.env` com `override:true` — sempre ganha.
2. Fallbacks sem override: `.env` na raiz (dev), `resourcesPath/.env`, `.../app.asar.unpacked/.env`, `.../app/.env` (legado).

#### 1.6.2 Segredos criptografados — `SECRET_KEYS` (16 total)
- **7 BYOK**: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `XAI_API_KEY`, `MISTRAL_API_KEY`, `OPENROUTER_API_KEY`.
- **4 transcrição/cleanup custom**: `ASSEMBLYAI_API_KEY`, `DEEPGRAM_API_KEY`, `CUSTOM_TRANSCRIPTION_API_KEY`, `CUSTOM_CLEANUP_API_KEY`.
- **5 enterprise**: `BEDROCK_ACCESS_KEY_ID`, `BEDROCK_SECRET_ACCESS_KEY`, `BEDROCK_SESSION_TOKEN`, `AZURE_OPENAI_API_KEY`, `VERTEX_API_KEY`.

`PERSISTED_KEYS` = `SECRET_KEYS` + ~30 chaves não-secretas.

#### 1.6.3 Criptografia e migração
- `init()` é lazy (chamado explicitamente, não no construtor) — evita tocar o Keychain antes de qualquer janela aparecer.
- **`_migrateToSecureStorage()`** (roda só se `secure-keys/.migrated` não existir): adota `CUSTOM_REASONING_API_KEY` legado; criptografa cada `SECRET_KEYS` e grava em `secure-keys/<NOME>.enc`, **verificando roundtrip** antes de aceitar; se qualquer chave falhar, aborta toda a migração (fail-safe, preserva `.env` em texto plano). Só depois escreve o sentinela `.migrated` — antes de reescrever o `.env` sem segredos.
- **`_loadAllSecrets()`**: lê cada `.enc` em paralelo; se `needsReencrypt` (mudança de chave de criptografia do SO), regrava automaticamente.
- **`_writeEnvFileAtomic`**: fila de escrita serializada em nível de módulo (`envWriteQueue`) — `HotkeyManager` cria sua própria instância de `EnvironmentManager`, então escritas concorrentes são serializadas para evitar colisão no `.env.tmp`.

#### 1.6.4 API pública
Getters/setters gerados dinamicamente para BYOK + escritos manualmente para AssemblyAI, Deepgram, Custom, Bedrock (5 campos), Azure (4), Vertex (3), hotkeys (`DictationKey`, `AgentKey`, `VoiceAgentKey`, `MeetingKey`), `ActivationMode`, `FloatingIconAutoHide`, `StartMinimized`, `PanelStartPosition`, `UiLanguage`. Todo `save*` chama `saveAllKeysToEnvFile()` assíncrono non-blocking.

### 1.7 Tray, Menu e Drag

- **`TrayManager`**: ícone com fallback gerado via `canvas`; menu de contexto (mostrar/ocultar ditado, abrir painel, sair); reage a eventos de show/hide/destroyed das janelas.
- **`MenuManager`**: menu de aplicação completo só no macOS; Windows/Linux usam menu por-janela (`setMenu`) só no painel de controle.
- **`DragManager`**: arrasto manual via IPC (necessário porque `frame:false` remove arrasto nativo) — `setInterval` de 16ms (~60fps) reposicionando a janela, clampado à área de trabalho.

### 1.8 `CliBridge` (`src/helpers/cliBridge.js`)

Servidor HTTP loopback para uma CLI externa conversar com a instância desktop já em execução.

- **Porta**: varre `8200`–`8219`.
- **Autenticação**: token bearer de 32 bytes, comparado via `crypto.timingSafeEqual`.
- **Descoberta**: `~/.ektoswhispr/cli-bridge.json` (`{version, port, token}`, `mode:0o600`).
- **Restrição de host**: só `127.0.0.1`/`::1`/`::ffff:127.0.0.1` — 403 antes de checar token.
- **Limite de corpo**: 1 MiB.
- **Endpoints v1**: `GET /v1/health`, `GET/POST /v1/notes/*` (list/search/:id/create/update/delete), `GET/POST /v1/folders/*`, `GET/DELETE /v1/transcriptions/*` (list/:id/delete/delete-audio). Erros `NOT_FOUND` → 404; outros → 500.

### 1.9 Sidecars e Migração

#### 1.9.1 `postMigrationDetector.js`
Detecta usuários voltando do bundle ID antigo (pré-"Gizmo"), exclusivo macOS. Sentinela `.bundle-migrated`; backoff de dispensa `.bundle-migrated-dismissed` (24h). Heurística: exige DB antigo + `.env` existentes (evidência de instalação real, não nova).

#### 1.9.2 `sidecarRegistry.js` / `sidecarPidFile.js`
- `register(name, stopFn)`; `shutdownAll()` roda tudo em paralelo com deadline de 8000ms.
- PID files em `userData/sidecar-pids/<name>.pid`; convenção: `write()` logo após spawn, `clear()` no `close`.

#### 1.9.3 `sidecarReaper.js`
`EXPECTED_BINARY_FRAGMENTS`: `parakeet: ["sherpa-onnx-ws-"]`, `whisper: ["whisper-server"]`, `llama: ["llama-server"]`, `diarization: ["sherpa-onnx-diarize"]`. `reapStaleSidecars()` (início de `startApp()`) verifica PIDs órfãos vivos, confirma que o comando real bate com os fragmentos esperados, e só então mata (evita matar um PID reciclado pelo SO). O fragmento `sherpa-onnx-online-ws-` foi removido junto com o binário/protocolo online (`docs/specs/audio-transcription-batching.md`) — não há mais runtime `"online"` no produto.

**Nota histórica**: havia uma entrada `qdrant: ["qdrant"]` até a remoção do subsistema Qdrant (`docs/specs/remove-qdrant-dependency.md`). A decisão foi removê-la junto com o resto, aceitando o risco residual de um processo Qdrant genuinamente órfão (de uma instalação pré-remoção) não ser reaproveitado pelo `reapStaleSidecars()` — julgado aceitável dado o estágio alpha do produto e a ausência de base instalada relevante. Ver a spec para o raciocínio completo.

### 1.10 `devServerManager.js`

- Porta: `EKTOSWHISPR_DEV_SERVER_PORT`/`VITE_DEV_SERVER_PORT`, default `5183`.
- `waitForDevServer()`: polling HTTP até 30 tentativas de 1s.
- `getAppFilePath(isControlPanel)`: produção resolve `app.getAppPath()/src/dist/index.html` com query string (`?panel=true`, `?agent=true`, `?update-notification=true`, `?transcription-preview=true`) — todas as janelas compartilham o mesmo bundle React via roteamento por query string.

### 1.11 Notas Finais de Arquitetura (Main Process)

1. **Ordem crítica de boot**: `reapStaleSidecars()` → managers (`IPCHandlers` antes das janelas carregarem) → `environmentManager.init()` → `registerSidecars()` → cache de settings → criação de janelas → hotkeys → Fase 2 → pré-aquecimento non-blocking.
2. **Duas fontes de verdade para settings**: `localStorage` (renderer) e `.env` em `userData` (main, fonte de verdade no boot antes de qualquer janela existir). `sync-startup-preferences` é o ponto central de sincronização.
3. **Padrão de mutação de dados**: `databaseManager.<op>()` → checar `success` → `broadcastToWindows` via `setImmediate` → efeitos assíncronos opcionais (vetorial/mirror).
4. **Sandbox difere por janela**: overlay principal usa `sandbox:true`; `agentWindow`/`controlPanelWindow` usam `sandbox:false` + `webSecurity:false` (obrigatório para `fetch` cross-origin a partir de `file://`).
5. **Janelas destruídas, não escondidas**: `agentWindow`, `controlPanelWindow` (hide-to-tray) e `transcriptionPreviewWindow` são destruídas ao fechar/ocultar — decisão deliberada de liberar memória.

---

## 2. Pipeline de Áudio e Transcrição

### 2.1 Visão Geral da Arquitetura

O pipeline de ditado tem duas metades em processos diferentes:

- **Renderer**: `src/helpers/audioManager.js` (`AudioManager`) — captura de microfone via MediaRecorder/Web Audio API, decide qual engine usar, monta o payload e dispara IPC ou fetch HTTP direto (cloud).
- **Main**: `src/helpers/whisper.js` (`WhisperManager`), `src/helpers/whisperServer.js` (`WhisperServerManager`), `src/helpers/parakeet.js` (`ParakeetManager`), `src/helpers/parakeetServer.js`/`parakeetWsServer.js` — spawnam e gerenciam os binários nativos que fazem a inferência real.

Hook de entrada: `src/hooks/useAudioRecording.js`.

**Lifecycle on-demand (ver `docs/specs/on-demand-model-lifecycle.md`)**: nenhum dos três engines locais
(Whisper, Parakeet, llama-server) pré-aquece no startup do app. `performStartRecording()` dispara
`AudioManager.warmupTranscriptionEngine()` (issued primeiro) e depois `warmupReasoningServer()`
(issued em seguida, sem aguardar o primeiro) — ambos fire-and-forget via
`whisperServerStart`/`parakeetServerStart`/`llamaServerStart` IPC, idempotentes. Meeting/Note
Recording (`meetingRecordingStore.ts`) e Upload (`UploadAudioView.tsx`) disparam o warm-up de
transcrição equivalente (sem warm-up de LLM, já que esses caminhos nunca passam pelo cleanup/agente).
Cada engine descarrega sozinho após um timeout de inatividade configurável —
`transcriptionIdleTimeoutMs` (Whisper/Parakeet, padrão 5min) e `llmIdleTimeoutMs` (llama-server,
padrão 5min), ambos com limites 30s–60min e totalmente independentes entre si.

Fluxo de alto nível (local, sem streaming):
```
hotkey → useAudioRecording.performStartRecording()
       → AudioManager.startRecording() (MediaRecorder + AudioWorklet PCM collector)
       → [fala do usuário] → hotkey de novo → AudioManager.stopRecording()
       → mediaRecorder.onstop → monta WAV 16kHz mono a partir do PCM
       → AudioManager.processAudio() → processWithLocalWhisper()/processWithLocalParakeet()/processWithOpenAIAPI()
       → IPC "transcribe-local-whisper"/"transcribe-local-parakeet" → main process
       → WhisperManager → WhisperServerManager.transcribe() (HTTP local)
         ou ParakeetManager → ParakeetServerManager.transcribe() (WebSocket local)
       → resultado → AudioManager.processTranscription() (cleanup/agent LLM opcional)
       → useAudioRecording.onTranscriptionComplete → paste automático + salvar no DB + limpeza de temporários
```

### 2.2 `AudioManager` (renderer)

#### 2.2.1 Captura de áudio — dois pipelines em paralelo
1. **MediaRecorder** (WebM/Opus, `audioBitsPerSecond: 128000`) — usado apenas como **fallback**. `RECORDING_TIMESLICE_MS = 250` emite chunks periódicos (mitigação para gravações curtas).
2. **AudioWorklet PCM collector** (`pcm-collector-processor`, `AudioContext` de 16kHz) — captura amostras Int16 em buffers de 1600 samples, acumuladas em `_pcmChunks`. **Caminho primário**: vira WAV 16kHz mono via `buildWavFromPcmChunks()`, sem depender do FFmpeg no main.

Antes de montar o WAV, `normalizePcmChunks()` faz **normalização de pico**: se o pico está entre `NORMALIZE_MIN_PEAK=500` e `NORMALIZE_TARGET_PEAK=29000` (~88% do máximo Int16), escala para o alvo (corrige microfones com ganho baixo no Windows). Limite: PCM collector para de acumular acima de **9.600.000 samples (10 minutos a 16kHz)**.

#### 2.2.2 Speech gate local e silence detection
`AnalyserNode` (fftSize 2048) lê RMS/pico a cada 200ms, alimenta `recordLocalSpeechWindow()`. Ao terminar, `getLocalSpeechGateDecision()` decide se pula a transcrição inteira (gravação silenciosa), mais agressivo quando o provider local é whisper.

#### 2.2.3 Seleção de dispositivo de microfone (`getAudioConstraints`)
- `echoCancellation:false`, `autoGainControl:false` sempre (AGC do Chromium mexe no volume do sistema via WASAPI no Windows).
- `noiseSuppression` = setting `micNoiseSuppression`.
- `channelCount:2` sempre (WebM mono quebra detecção de silêncio no Linux/PipeWire).
- `preferBuiltInMic` fixa `deviceId` do mic embutido (cacheado); senão usa `selectedMicDeviceId`; `forceDefaultMic=true` (retry) ignora tudo e usa o default do SO (device pinado sumiu/rotacionado).
- **Persistent mic stream**: reutiliza stream aberto por até `MIC_STREAM_KEEP_ALIVE_MS=20000`ms (evita delay de wake-up de headsets USB/wireless); invalidado por `devicechange`.

#### 2.2.4 Roteamento local vs. cloud (`processAudio`)
```js
if (useLocalWhisper) {
  if (localProvider === "nvidia") { processWithLocalParakeet }
  else { processWithLocalWhisper }
} else { processWithOpenAIAPI }
```
Cada ramo tenta reaproveitar texto já produzido pelo **preview de streaming** (`metadata.stopPreviewResult`) antes de reprocessar o áudio inteiro.

#### 2.2.5 `processWithLocalWhisper`
1. Converte blob → `ArrayBuffer`.
2. Monta `options.language` + `options.initialPrompt` (hint de idioma + dicionário, ver §2.9).
3. IPC `transcribe-local-whisper`.
4. Se o resultado é eco do prompt de dicionário (`isDictionaryEcho`), lança `"No audio detected"`.
5. `processTranscription()` (cleanup/agent).
6. **Fallback**: se falhar e `allowOpenAIFallback && useLocalWhisper`, tenta `processWithOpenAIAPI` (`source: "openai-fallback"`).

#### 2.2.6 `processWithLocalParakeet`
Mesmo padrão via IPC `transcribe-local-parakeet`.

#### 2.2.7 `processWithOpenAIAPI` — Cloud STT
- Resolve `apiKey` (cache por provider: openai/groq/mistral/xai/custom).
- `FormData`: `file`, `model`, `language` (se != "auto").
- **Prompt de dicionário truncado por provider**: Groq rejeita >896 chars → `MAX_PROMPT_CHARS = isGroqEndpoint ? 890 : 900`.
- **Streaming SSE**: só para OpenAI `gpt-4o-transcribe`/`gpt-4o-transcribe-diarize`/`gpt-4o-mini-transcribe*`.
- **Providers com proxy via main** (evitam CORS/auth não-Bearer): `mistral` (header `x-api-key`, `contextBias`), `xai` (`keyterms`).
- **Endpoints**: OpenAI, Groq, xAI, Mistral, custom/self-hosted. Suporte a **Azure OpenAI** (header `api-key`, URL de deployment com `?api-version=`). Endpoints custom exigem HTTPS.
- Erros HTTP: 401→`INVALID_KEY`, 429→`PROVIDER_RATE_LIMITED`, ≥500→`SERVER_ERROR`.
- **Fallback local**: se falhar e `allowLocalFallback && !useLocalWhisper`, tenta `transcribeLocalWhisper` com `fallbackWhisperModel` (default `"base"`).

#### 2.2.8 Streaming em tempo real (OpenAI Realtime, cloud)
`shouldUseStreaming()`: não-local, não self-hosted, modo != "batch", modelo em `REALTIME_MODELS={"gpt-4o-mini-transcribe","gpt-4o-transcribe"}`, provider `"openai"`, modo `"byok"` com key presente.

`startStreamingRecording()`: abre `getUserMedia`, cria `MediaRecorder` de fallback em paralelo, `AudioWorkletNode("pcm-streaming-processor")` sobre `AudioContext` 16kHz, registra listeners antes de `provider.start()` (não perder eventos no handshake), IPC `dictationRealtimeStart` abre WebSocket real no main.

`stopStreamingRecording()`: atualiza UI, envia "stop" ao worklet, espera 120ms (flush), `provider.finalize?.()`, espera 300ms, `provider.stop()`. Sem `finalText` mas com `fallbackBlob` >2s → batch fallback. Roda cleanup/agent sobre o texto final.

#### 2.2.9 `openaiRealtimeStreaming.js` (main) — WebSocket real
- `wss://api.openai.com/v1/realtime?intent=transcription`.
- `session.update` com `turn_detection: {type:"server_vad", threshold:0.6, silence_duration_ms:600, prefix_padding_ms:500}`.
- Áudio como `input_audio_buffer.append` (base64 PCM); resample linear se `captureRate !== inputRate` (16kHz→≥24kHz).
- **Cold-start buffer**: até `COLD_START_BUFFER_MAX=3s` antes do WebSocket existir.
- **Keep-alive**: ping/pong a cada `KEEPALIVE_INTERVAL_MS=15000`ms.
- **Limite de sessão**: `SESSION_PREEMPT_MS=55min` (antes do limite real de 60min da OpenAI).

#### 2.2.10 Roteamento para cleanup/agent (`processTranscription`)
1. Vazio ou `skipReasoning` → retorna cru.
2. Calcula `cleanupReachable`/`agentReachable` via `resolveDictationAgentReachability`.
3. `resolveReasoningRoute()` decide `kind`: `"agent"` (wake word ou `voiceAgentRequested`), `"cleanup"`, `"skip"`.
4. `processWithReasoningModel()` → `ReasoningService.processTextStreamed()` com callback de streaming parcial.
5. Erro → fallback silencioso ao texto cru.

#### 2.2.11 Persistência
Respeita `dataRetentionEnabled`. Salva via IPC `saveTranscription` + `saveTranscriptionAudio`. Falhas também são salvas (`status:"failed"`) para retry. Gravações descartadas só são salvas se `shouldSaveDiscardedRecording()` decidir (duração mínima); se a gravação de áudio falhar, a linha "discarded" vazia é deletada.

### 2.3 Whisper.cpp Local (`src/helpers/whisper.js`)

#### 2.3.1 Modelos e armazenamento
Fonte: `src/models/modelRegistryData.json → whisperModels`. Armazenados em **`~/.cache/ektoswhispr/whisper-models/`**.

| Modelo | Arquivo | Tamanho |
|---|---|---|
| tiny | `ggml-tiny.bin` | ~75MB |
| base (recomendado) | `ggml-base.bin` | ~142MB |
| small | `ggml-small.bin` | ~466MB |
| medium | `ggml-medium.bin` | ~1.5GB |
| large | `ggml-large-v3.bin` | ~3GB |
| turbo | `ggml-large-v3-turbo.bin` | ~1.6GB |

Download: checa espaço em disco (`size*1.2`), timeout 600000ms, sinal de abort, valida tamanho final. `validateModelName()` restringe a nomes conhecidos (proteção contra path traversal).

#### 2.3.2 VAD model (Silero)
`ggml-silero-v5.1.2.bin` em `resources/bin/whisper-vad/`.

#### 2.3.3 Pre-warm no startup
Se `localTranscriptionProvider==="whisper"` e há modelo baixado, inicia `whisper-server` antecipadamente. `effectiveUseCuda = gpuMode==="cpu" ? false : !!useCuda`.

#### 2.3.4 `transcribeLocalWhisper` → `_runServerTranscription`
Exige binário do servidor (**sem modo CLI**, sempre via servidor HTTP). Marca `_transcribing=true` (impede re-warm pós-sleep matar transcrição em andamento). Converte para `Buffer`. `parseWhisperResult()` normaliza formato CLI antigo e formato do servidor, detecta `[BLANK_AUDIO]`.

#### 2.3.5 Detecção de alucinação (`isHallucinatedText`)
- Caracteres musicais (`♪♫♩♬`).
- Frases-boilerplate (`"thanks for watching"`, `"subtitles by"`, etc.).
- **Script mismatch**: idioma latino configurado mas >30% dos caracteres fora do range Latin Extended-B.
- **Loop de repetição**: ≥8 palavras e primeira metade == segunda metade.

#### 2.3.6 CUDA (`whisperCudaManager.js`)
Download separado do binário CUDA (linux/win32, não macOS), do release GitHub `OpenWhispr/whisper.cpp` (`whisper-server-{platform}-x64-cuda.zip`), extraído para `userData/bin/`.

### 2.4 `whisperServer.js` — servidor HTTP local

- Resolução de binário: CUDA primeiro em `userData/bin/` (se `preferCuda`), senão bundled em `resources/bin/`.
- **Threads**: `resolveWhisperThreads` — explícito, ou `WHISPER_THREADS=auto` → `clamp(floor(availableParallelism*0.75), 4, 12)`. Fallback automático para default se auto-tune falhar no startup.
- **Args**: `--model --host 127.0.0.1 --port [--threads N] --best-of 5 --language [--vad --vad-model --vad-threshold ...]`.
- **No-op guard**: mesmo modelo + assinatura VAD + assinatura threads → no-op.
- **Seleção de GPU por UUID+PCI_BUS_ID**: `CUDA_DEVICE_ORDER=PCI_BUS_ID`, `CUDA_VISIBLE_DEVICES=TRANSCRIPTION_GPU_UUID`.
- **CUDA fallback runtime**: se `usingCuda` e o processo morre cedo (<10s), emite `"cuda-fallback"` e reinicia automaticamente em CPU (diferente do Parakeet).
- `STARTUP_TIMEOUT_MS=30000`; timeout de transcrição 300000ms (5min).
- Pula FFmpeg se o buffer já é WAV 16kHz mono PCM pronto.
- **Re-warm pós-sleep**: só se CUDA + modelo + nada em andamento.

### 2.5 NVIDIA Parakeet (`parakeet.js`, `parakeetServer.js`, `parakeetWsServer.js`)

#### 2.5.1 Modelos (fonte: `modelRegistryData.json → parakeetModels`)

| Modelo | Idioma | Tamanho | Runtime |
|---|---|---|---|
| `parakeet-tdt-0.6b-v3` | Multilíngue (24) | 680MB | offline |
| `parakeet-unified-en-0.6b` | Inglês, SOTA | 631MB | offline |

Os três modelos anteriormente listados aqui com `runtime:"online"` (`nemotron-speech-streaming-en-0.6b`,
`nemotron-3.5-asr-streaming-0.6b`, `nemotron-3.5-asr-streaming-0.6b-1120ms`) foram **removidos do
produto inteiramente** (ver §2.6.4 e `docs/specs/audio-transcription-batching.md`) — não tinham
caminho de execução offline/batch disponível no sherpa-onnx vendorizado. Todo modelo restante no
registry é `offline`, então não há mais nenhum campo `runtime:"online"` em `modelRegistryData.json`.
Usuários previamente em um dos três IDs removidos são migrados para `parakeet-tdt-0.6b-v3` no
próximo lançamento. Armazenados em `~/.cache/ektoswhispr/parakeet-models/`; exige
`REQUIRED_MODEL_FILES=["encoder.int8.onnx","decoder.int8.onnx","joiner.int8.onnx","tokens.txt"]`.

#### 2.5.2 Download
`.tar.bz2` do GitHub `k2-fsa/sherpa-onnx` releases; extração via `tar` do sistema ou fallback `unbzip2-stream`+`tar` JS.

#### 2.5.3 `ParakeetServerManager` (offline)
Converte para WAV → float32 PCM. **Chunking**: segmentos >`MAX_SEGMENT_SECONDS=15s` divididos e concatenados. Silêncio: `RMS < SILENCE_RMS_THRESHOLD=0.001` → texto vazio sem chamar o servidor.

#### 2.5.4 `ParakeetWsServer`
Binário `sherpa-onnx-ws-{platform}-{arch}` (offline apenas), variante `-cuda`. Porta **6006-6029**.
**Nota histórica**: até `docs/specs/audio-transcription-batching.md`, existia também um runtime `"online"`
(binário `sherpa-onnx-online-ws-{platform}-{arch}`, `createOnlineStream()`/`_transcribeOnline()`) usado
pelos três modelos Nemotron streaming-only. Esses três modelos foram removidos do produto (não tinham
caminho offline/batch) e o runtime online — binário, protocolo e primitivas — foi removido por completo;
`ParakeetWsServer` hoje só conhece o runtime offline.

**Regra crítica de GPU**: Parakeet **sempre** tenta CUDA quando GPU + binário CUDA presentes — sem toggle de CPU equivalente ao `WHISPER_GPU_MODE`. Citação do próprio código: *"NVIDIA (Parakeet) transcription always runs on CUDA when the hardware and the CUDA binary are both present ... Selecting CPU only ever applies to the OpenAI/Whisper engine — NVIDIA models are never downgraded to CPU while a usable GPU is available."*

Args: `--tokens --encoder --decoder --joiner --port --num-threads`; `--provider=cuda` se `useCuda`. Threads: `max(1,min(4,cpus*0.75))`, ou `1` se CUDA. **Warm-up automático** pós-start. `STARTUP_TIMEOUT_MS=60000`, `TRANSCRIPTION_TIMEOUT_MS=300000`.

**Protocolo (offline, único suportado)**: mensagem binária `[int32LE sample_rate][int32LE num_bytes][float32 samples...]`; servidor responde JSON; cliente confirma "Done".

#### 2.5.5 Diarização com Parakeet
`DiarizationManager.diarize()` produz segmentos `{start,end,speaker}`; transcreve por turno de fala. `mergeSpeakerTurns()` (`maxGapSec:1.5, maxTurnSec:60`); `buildSpeakerLabels()`. Sem segmentos → transcrição plana.

### 2.6 VAD (Voice Activity Detection) e Batching Progressivo de Ditado

Ver `docs/specs/audio-transcription-batching.md` (implementado). O mecanismo abaixo é o
comportamento **padrão, sempre ativo** do Ditado local para ambos os engines (Whisper e Parakeet
offline-runtime) — não é mais um recurso de "preview" opt-in atrás de um toggle. Isso substitui o
comportamento anterior descrito nesta seção (preview opt-in + `parakeetStreamingBeta`/streaming
real do Parakeet).

#### 2.6.1 Configuração base
```json
DEFAULTS: {threshold:0.5, minSpeechDurationMs:100, minSilenceDurationMs:200, maxSpeechDurationS:30, speechPadMs:200, samplesOverlap:0.5}
LIMITS: {threshold:[0.1,0.95], minSpeechDurationMs:[50,2000], minSilenceDurationMs:[50,2000], maxSpeechDurationS:[5,120], speechPadMs:[0,1000], samplesOverlap:[0,0.95]}
```
VAD Silero real ativado por contexto (`dictationSileroEnabled`, `noteRecordingSileroEnabled`, `meetingSileroEnabled`, default `true`), passado ao `whisper-server` como `--vad`. Camada diferente do VAD JS-side abaixo (server-side, dentro de uma única chamada `/inference`; usado pela transcrição de fallback e por Meeting/Upload).

#### 2.6.2 `dictationBatchingSession.js` — sessão de batching compartilhada por engine (renomeado de `whisperStreamingSession.js`)
Nenhum dos dois engines tem encoder incremental — cada chamada de inferência reprocessa o chunk inteiro. Solução: segmentar PCM ao vivo por silêncio (energy VAD + hangover) e transcrever cada utterance fechada **exatamente uma vez**; texto committed só cresce. A mecânica interna (frames, pre-roll, merge) é idêntica para os dois engines — só o par de callbacks `transcribe`/`isLowQuality` muda.

- Frames de `frameMs=20ms`, RMS por frame. **Voiced** quando `rms >= max(energyThreshold=0.006, noiseFloor*3)` (noiseFloor é EMA adaptativo, atualizado só durante silêncio).
- **Pre-roll**: buffer circular durante silêncio para contexto de lead-in quando fala é confirmada (`voicedRunMs >= minSpeechMs`).
- Fecha segmento quando `silenceRunMs >= minSilenceMs`, ou força flush em `maxSpeechDurationS` (mantendo overlap).
- Segmentos com RMS total < `minSegmentRms=0.003` descartados sem inferência.
- **Merge adaptativo de baixa qualidade**: se `isLowQuality` indica baixa confiança, áudio não é commitado — retido e prependido ao próximo utterance (até `maxMerges=2`, `maxMergedMs=20000`).
- **Novo: `TAIL_FINALIZE_BUDGET_MS = 300ms`** — orçamento de tempo (wall-clock) que só se aplica enquanto `finish()` (chamado na soltura da hotkey) decide se adia (merge) a última utterance ainda aberta. Uma vez excedido, a cauda é commitada best-effort imediatamente, mesmo que ainda esteja dentro de `maxMerges`/`maxMergedMs` — gatilho separado e independente do gate `lowQualityRatio`/`coverageRatio` de sessão inteira abaixo.
- `requestPartial()`: re-transcreve utterance aberto, nunca compete com commit pendente; só é agendado (timer de 1500ms) quando `showOverlay` é `true` — é puramente cosmético e nunca afeta o texto commitado/colado.
- `finish()`: força flush, retorna `{text, segments, finalized, quality:{committedMs, lowQualityMs, totalInputMs, lowQualityRatio, coverageRatio}}`.

**Configuração própria ("Live"), independente do Silero VAD
(`docs/specs/live-preview-vad-sensitivity.md`, `docs/specs/vad-settings-tabs.md`,
implementados)**: nenhum dos 11 campos que o construtor de `DictationBatchingSession`
consome (exceto `tailFinalizeBudgetMs`, margem interna de segurança de latência nunca
exposta) **é lido/derivado do `whisperVad.json`/`_resolveWhisperVadOptions()` do Silero** —
vêm de `src/constants/previewVad.json` + `src/helpers/previewVadConfig.js`
(`DEFAULT_PREVIEW_VAD_CONFIG`, `clampPreviewVadField`, `sanitizePreviewVadConfig`,
`resolvePreviewVadConfig` — genérico sobre `Object.keys(DEFAULTS)`, todos os 11 campos
passam pelo mesmo código sem alteração estrutural). Os 10 campos expostos como controle de
UI, com seus defaults (idênticos às constantes internas hardcoded originais de
`dictationBatchingSession.js`, sem mudança de comportamento na migração): `minSpeechDurationMs:
80`, `minSilenceDurationMs: 500`, `speechPadMs: 100`, `maxSpeechDurationS: 20`,
`samplesOverlap: 0.3`, `energyThreshold: 0.006`, `minSegmentRms: 0.003`, `noiseFloorFactor: 3`,
`noiseFloorAlpha: 0.05`, `maxMerges: 2`, `maxMergedMs: 20000`. Persistido via IPC própria
(`preview-vad-get-config`/`preview-vad-set-config`), `_resolvePreviewVadOptions()` em
`ipcHandlers.js`, e chaves de `localStorage` correspondentes em `settingsStore.ts` — sem
relação de schema com o `whisperVad.json` do Silero. `start-dictation-preview` distribui os 5
campos de formato `vad` (`minSpeechDurationMs`, `minSilenceDurationMs`, `speechPadMs`,
`maxSpeechDurationS`, `samplesOverlap`) dentro de `vadConfig`, e os outros 6
(`energyThreshold`, `minSegmentRms`, `noiseFloorFactor`, `noiseFloorAlpha`, `maxMerges`,
`maxMergedMs`) como opções de nível superior do construtor — dois caminhos de código
diferentes dentro de `DictationBatchingSession`. Configurável em Settings → Fala-para-Texto →
Ditado, agora em duas abas — "Live" (este detector de energia, 10 campos, aba padrão) e
"Voice Activity Detection" (Silero, seção inalterada) — via `DictationVadTabs`
(`SettingsPage.tsx`, export nomeado, reutiliza o padrão `ProviderTabs`/`useSubTab`/`TabPanel`
já usado por `SpeechToTextTabs`/`LlmsTabs`; sem barra de abas quando o provedor local é
nvidia/Parakeet, já que Silero não se aplica).

#### 2.6.3 Sinal de confiança por engine (`src/utils/transcriptionQualityHeuristics.js`)
- **Whisper**: `isWhisperSegmentLowQuality` via limiares clássicos (`avg_logprob < -1.0` ou `compression_ratio > 2.4`), usando os campos reais de `avg_logprob`/`compression_ratio`/`no_speech_prob` do whisper.cpp.
- **Parakeet (offline-runtime)**: não existe campo de confiança nativo no protocolo JSON do binário offline-websocket-server do sherpa-onnx. `isParakeetSegmentLowQuality` usa um heurístico derivado de texto — desvio deliberado e sinalizado, não uma substituição silenciosa: razão de compressão via zlib (mesma técnica que o whisper.cpp usa para `compression_ratio`), o detector de alucinação compartilhado (`isHallucinatedText`), e o RMS do chunk.
- `isHallucinatedText` (padrões de alucinação conhecidos, rejeição de script não-latino, detecção de loop de repetição) mora aqui como implementação canônica; `WhisperManager.isHallucinatedText` (`whisper.js`) agora é um wrapper fino que delega para cá.

#### 2.6.4 Integração em `ipcHandlers.js` (`start/stop-dictation-preview`)
- Ambos os engines (Whisper e Parakeet offline-runtime) criam uma `dictationBatchingSession` com o par de callbacks `transcribe`/`isLowQuality` apropriado — única diferença de wiring entre os dois.
- O `vadConfig` passado a `createDictationBatchingSession` vem inteiramente de
  `this._resolvePreviewVadOptions()` (novo namespace "Live Preview Sensitivity" — ver
  §2.6.2) — **não** lê mais `_resolveWhisperVadOptions("dictation")`/Silero para nenhum
  campo. Um clamp experimental (`Math.min`/`Math.max`) que fazia esse empréstimo
  silenciosamente foi removido; nada mais é limitado/floor sem aparecer na tela.
- `showOverlay` (booleano passado pelo renderer, espelhando `showTranscriptionPreview`) controla **apenas** se a janela de legenda ao vivo é exibida — a sessão de batching roda de qualquer forma, sempre que o modelo/engine é elegível.
- **Filtro de qualidade no stop**: só retorna para paste direto se `finalized && lowQualityRatio <= 0.5 && coverageRatio >= 0.4`. Senão, cai para re-transcrição offline autoritativa do WAV completo.
- **Os três modelos Parakeet `runtime: "online"` foram removidos do produto inteiramente** (decisão do project owner, Opção A — ver o spec): `nemotron-speech-streaming-en-0.6b`, `nemotron-3.5-asr-streaming-0.6b`, `nemotron-3.5-asr-streaming-0.6b-1120ms`, junto com a flag/toggle `parakeetStreamingBeta` e as primitivas de streaming real agora mortas (`ParakeetWsServer.createOnlineStream()`/`_transcribeOnline()`/`_warmUpOnline()`, binário `sherpa-onnx-online-websocket-server`). Não há mais exceção de streaming por modelo — exatamente um mecanismo unificado de batching/qualidade para todos os engines locais. Usuários previamente configurados em um dos três IDs removidos são migrados para `parakeet-tdt-0.6b-v3` no próximo lançamento (`src/helpers/parakeetModelMigration.js`, checado a cada lançamento — idempotente, sem sentinel).

### 2.7 GPU / CUDA — Decisão CPU vs GPU

#### 2.7.1 Detecção (`src/utils/gpuDetection.js`)
`detectNvidiaGpu()` via `nvidia-smi` (cacheado, sempre `false` no macOS). `listNvidiaGpus()` lista todas com UUID (seleção manual). `detectIntelGpu()` via `app.getGPUInfo("complete")`.

#### 2.7.2 Resolução de modo (`src/utils/gpuModeResolver.js`)
```
resolveWhisperGpuMode({mode,hasNvidia,cudaReady}):
  "gpu-nvidia"→"gpu-nvidia"; "cpu"→"cpu"; hasNvidia&&cudaReady→"gpu-nvidia" (auto); senão "cpu"
```
Whisper: `auto|cpu|gpu-nvidia`. LLM local: `auto|cpu|gpu-intel|gpu-nvidia`.

#### 2.7.3 O botão de GPU nas Settings — **só controla o Whisper**
IPC `set-whisper-gpu-mode` grava `WHISPER_GPU_MODE`, reinicia o servidor. `_resolveWhisperUseCuda`: `"cpu"`→`false`; senão `WHISPER_CUDA_ENABLED==="true" && whisperCudaManager.isDownloaded()`.

#### 2.7.4 Parakeet/NVIDIA **sempre** tenta CUDA (regra dura)
Ver §2.5.4 — sem toggle equivalente. Confirma a regra: "Whisper segue o botão CPU/GPU; qualquer modelo NVIDIA/Parakeet sempre usa CUDA quando há GPU presente."

#### 2.7.5 Seleção de GPU específica (multi-GPU)
`TRANSCRIPTION_GPU_UUID` aplicado tanto ao `whisper-server` quanto ao `parakeet-ws` como `CUDA_VISIBLE_DEVICES` + `CUDA_DEVICE_ORDER=PCI_BUS_ID`. Mudar a GPU reinicia o servidor.

### 2.8 Diarização (`src/helpers/diarization.js`)

Modelos: `sherpa-onnx-pyannote-segmentation-3-0` (~6.6MB, segmentação), `3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx` (~28.2MB, embedding de locutor), Silero VAD auxiliar. Bundled em `resources/bin/diarization-models/` ou baixados para `~/.cache/ektoswhispr/diarization-models/`.

Binário `sherpa-onnx-diarize-{platform}-{arch}`. Args: `--segmentation.pyannote-model`, `--embedding.model`, `--clustering.num-clusters=-1` (auto), `--clustering.cluster-threshold=0.55`, `--min-duration-on=0.2`, `--min-duration-off=0.5`. Timeout 300000ms (5min). Saída parseada via regex `^(\d+\.?\d*)\s+--\s+(\d+\.?\d*)\s+(speaker_\d+)$`.

**Fusão com transcrição** (`mergeWithTranscript`, reuniões mic+system): dedupe de "vazamento" de áudio do sistema no mic (`dedupeMicAgainstSystem`). Segmentos de mic sempre `"you"`; segmentos de sistema recebem o speaker com maior overlap temporal.

**Conversão PCM→WAV** (`convertRawPcmToWav`): streaming (não carrega tudo em memória), header WAV de 44 bytes calculado manualmente + pipe direto.

### 2.9 Custom Dictionary — Prompt do Whisper

`customDictionary: string[]` (settings). `getDictionaryHintWords()`: se há snippets configurados, **os triggers dos snippets também entram como hints** de dicionário.

`AudioManager.getCustomDictionaryPrompt()` combina com hint de idioma → `initialPrompt`, usado no whisper local, no preview de streaming e na API cloud (truncado a 890/900 chars).

**Filtro de eco de dicionário** (`src/utils/dictionaryEchoFilter.js`): whisper às vezes "aluciona" repetindo o próprio prompt. `matchesDictionaryPrompt`: normaliza ambos; eco confirmado se `textComposition >= 0.9 && dictionaryUsage >= 0.7` (texto quase inteiramente composto de palavras do dicionário E usa boa parte do dicionário inteiro).

**Auto-learn (correção automática do dicionário via monitor de texto)**: depois de um `paste-text`, se `_autoLearnEnabled` estiver ligado, `TextEditMonitor.startMonitoring(text, 30000, {targetPid})` observa o campo de destino nativamente (AT-SPI2/UI Automation/AXObserver — ver §7.7) usando exatamente a mesma string `text` recebida pelo handler `paste-text` como baseline — **nunca** `textToPaste` (que já tem snippets aplicados + espaço final da smart-spacing) — de forma que, quando Text Cleanup está ativo, a baseline já é o texto pós-cleanup (nunca o transcript bruto pré-cleanup), pois `text` chega ao handler exatamente como `AudioManager.processTranscription()` o retornou. Qualquer mudança relatada pelo binário nativo emite `text-edited` (`{originalText, newFieldValue}`); `ipcHandlers.js`'s `_setupTextEditMonitor()` faz debounce de 1500ms (`AUTO_LEARN_DEBOUNCE_MS`) e chama `_processCorrections()`, que delega a lógica principal a `src/helpers/autoLearnDictionary.js` (`processAutoLearnCorrections()` — extraído para ser testável isoladamente sem instanciar a classe `IPCHandlers` inteira).

`src/utils/correctionLearner.js`'s `extractCorrections(originalText, fieldValue, existingDictionary)` isola a região editada (substring exata ou janela deslizante com ≥30% de overlap de palavras — ignora texto digitado *depois* do trecho colado), alinha palavras via LCS, descarta reescritas (>50% das palavras mudaram), e filtra substituições por: já está no dicionário, duplicata no mesmo evento, palavras idênticas (case-insensitive), corrigida com menos de 3 caracteres, ou distância de edição (Levenshtein) > 0.65 do original. Retorna `Array<{from, to}>` (não mais `string[]`) — `from` é a palavra original mal-transcrita, `to` é a palavra corrigida; apenas `to` entra na lista de hint words operativa do Whisper.

**Proveniência (`learned_from`)**: coluna `TEXT` nullable em `custom_dictionary`, populada apenas quando uma nova linha `source = 'learned'` é inserida (armazena o `from` da correção). É usada **exclusivamente** pelo guard de anti-oscilação: antes de persistir `{from, to}`, verifica se já existe uma linha `source = 'learned'` com `word = from` e `learned_from = to` (case-insensitive) — a reversão exata de uma correção já aprendida — e, se sim, descarta o par silenciosamente (log em nível debug), sem tocar a linha existente. É uma proteção heurística, não uma garantia contra ciclos mais complexos (A→B→C→A). `learned_from` é limpo (`NULL`) quando uma linha `learned` é promovida a `manual` (o usuário reendossa a palavra manualmente), e é **excluído deliberadamente** de `getPendingDictionary()` (payload de push para sync na nuvem) — fica local a este dispositivo, nunca sincroniza. `learned_from` **nunca** é aplicado como regra de find/replace em lugar nenhum (prompt do Whisper, cleanup, paste) — a funcionalidade de substituição real já existe via Snippets (`trigger` → `replacement`); o dicionário custom continua sendo estritamente sobre ensinar a grafia correta de uma palavra.

### 2.10 Resumo de Configurações Persistidas

**Settings**: `useLocalWhisper`, `localTranscriptionProvider`, `whisperModel`, `parakeetModel`, `showTranscriptionPreview` (agora controla apenas a janela de legenda ao vivo, não a velocidade da transcrição — ver §2.6), `preferredLanguage`, `customDictionary`, `snippets`, `micGain`/`micNoiseSuppression`/`preferBuiltInMic`/`selectedMicDeviceId`, `allowOpenAIFallback`/`allowLocalFallback`/`fallbackWhisperModel`, `cloudTranscriptionProvider`/`Model`/`Mode`/`BaseUrl`, `dictationSileroEnabled`/`noteRecordingSileroEnabled`/`meetingSileroEnabled`, `useCleanupModel`/`useDictationAgent`, `dataRetentionEnabled`, `autoPasteEnabled`/`keepTranscriptionInClipboard`/`pauseMediaOnDictation`/`autoUnmuteMicEnabled`. (`parakeetStreamingBeta` foi removido — ver §2.6.4.)

**Env vars (main)**: `WHISPER_GPU_MODE` (só whisper), `WHISPER_CUDA_ENABLED`, `WHISPER_THREADS`, `SHERPA_ONNX_CUDA_ENABLED` (dinâmico, sem toggle manual), `TRANSCRIPTION_GPU_UUID`, `LLAMA_GPU_MODE`/`INTELLIGENCE_GPU_UUID`, `LOCAL_TRANSCRIPTION_PROVIDER`, `PARAKEET_MODEL`.

---

## 3. Hotkeys, Plataforma e Detecção de Reuniões

### 3.1 Arquitetura Geral de Hotkeys (`src/helpers/hotkeyManager.js`)

`HotkeyManager` (estende `EventEmitter`) gerencia todos os atalhos globais, abstraindo três backends: (1) Electron `globalShortcut` (padrão macOS/Windows/Linux X11); (2) backends nativos Linux (GNOME via D-Bus+gsettings, Hyprland via D-Bus+hyprctl, KDE via KGlobalAccel D-Bus) — necessários porque Wayland não permite captura global por apps comuns; (3) listeners nativos de baixo nível (Windows: `windows-key-listener.exe`; macOS: Globe/Fn) para combinações somente-modificador e push-to-talk.

#### 3.1.1 Modelo de "Slots" nomeados
Cada slot guarda uma **lista** de hotkeys: `this.slots = new Map()` → `{hotkeys: string[], callback, accelerators: (string|null)[]}`. Slots: **`dictation`** (único que suporta push-to-talk), **`agent`** (overlay de chat), **`voiceAgent`** (dita direto para o dictation agent, sem wake word, sempre ignora cleanup), **`meeting`** (reunião manual), **`cancel`** (Escape durante captura de hotkey na UI — nunca roteado por GNOME/KDE nativo).

`GNOME_NATIVE_SLOTS = {"agent","meeting","voiceAgent"}` — dictation no GNOME é tratado à parte.

#### 3.1.2 Parsing de hotkey (`src/helpers/hotkeyList.js`)
Armazenado como string separada por vírgula. `parseHotkeyList()` dedup, remove espaços/vazios, preserva ordem, trata caso especial de hotkey literal `,`.

#### 3.1.3 Classificação de tipos
`isModifierOnlyHotkey` (ex. `"Control+Super"`, nunca passa por `globalShortcut`), `isRightSideModifier` (`RightControl`/`RightAlt`/etc., listener nativo), `isGlobeLikeHotkey` (`GLOBE`/`Fn`, macOS), `isMouseButtonHotkey` (`MouseButton4/5`, macOS), `normalizeToAccelerator`.

#### 3.1.4 `registerSlot(slotName, hotkeyInput, callback, options)`
1. Backends nativos Linux só suportam **1 acelerador por slot** (usa apenas `hotkeys[0]`).
2. GNOME + slot nativo → converte formato, registra via gsettings, associa callback.
3. KDE + slot ≠ `cancel` → registra via KGlobalAccel.
4. Senão → `setupShortcuts()` (globalShortcut).

#### 3.1.5 `setupShortcuts()` — via `globalShortcut`
Rejeita antecipadamente conflito com **outro slot** (`_findSlotConflict`). Registro **best-effort**: sucede se pelo menos um hotkey da lista registrar; com `{atomic:true}` (usado em `updateHotkey`), qualquer falha causa rollback total.

#### 3.1.6 Defaults por plataforma e fallback
```
DEFAULT_HOTKEY = "Control+Super"; FALLBACK_HOTKEYS = ["F8","F9","Control+Shift+Space"]
defaultDictation = darwin ? "GLOBE" : "Control+Super"
```
`getEffectiveDefaultHotkey()`: macOS→`"GLOBE"`; Linux X11 ou GNOME (não suportam combo somente-modificador/exigem tecla normal)→`FALLBACK_HOTKEYS[0]` (`F8`); demais→`DEFAULT_HOTKEY`.

`loadSavedHotkeyOrDefault()`: tenta salvo → default efetivo → percorre `FALLBACK_HOTKEYS`. Ao usar fallback, persiste **apenas no `.env`** (não localStorage) — preferência do usuário é retentada a cada boot mesmo com conflito persistente.

#### 3.1.7 Duas fontes de verdade
`getSavedHotkey()`: localStorage (`dictationKey`) primeiro, `.env` (`DICTATION_KEY`) como backup, default final `DEFAULT_HOTKEY` — intencional: localStorage guarda a preferência real mesmo que `.env` tenha fallback temporário.

#### 3.1.8 `initializeHotkey()` — ordem de tentativa
GNOME → Hyprland (Wayland, não-GNOME) → KDE → `globalShortcut` padrão. Cada backend, se OK, agenda registro (delay `HOTKEY_REGISTRATION_DELAY_MS=1000ms` para localStorage carregar); se falhar, tenta `FALLBACK_HOTKEYS` via backend nativo; se tudo falhar, desativa o backend e cai para `globalShortcut`.

#### 3.1.9 `getNativeListenerKeys(activationMode)`
Inclui na lista de "watch" nativo: push-to-talk no slot `dictation` (só dictation suporta PTT) + qualquer hotkey `isModifierOnlyHotkey`/`isRightSideModifier` em qualquer slot.

#### 3.1.10 API de consulta/notificação
`notifyActiveHotkey` → `dictation-key-active`; `notifyHotkeyFallback` → `hotkey-fallback-used`; `notifyHotkeyFailure` → `hotkey-registration-failed`; `isUsingGnome/Hyprland/KDE/NativeShortcut()` — UI esconde seletor de push-to-talk quando `true` (nenhum backend nativo Linux suporta PTT).

### 3.2 Push-to-Talk Nativo no Windows

#### 3.2.1 `windowsKeyManager.js`
Um processo `windows-key-listener.exe` **por tecla observada**. `setKeys(keys)` reconcilia idempotentemente (mata processos não desejados, spawna novos). Resolve binário em vários caminhos candidatos; se ausente, emite `unavailable` uma vez — PTT cai silenciosamente para modo tap. Parseia stdout: `READY`, `KEY_DOWN`, `KEY_UP`.

#### 3.2.2 `resources/windows-key-listener.c`
`SetWindowsHookEx(WH_KEYBOARD_LL)` + message loop. `ParseCompoundHotkey` tokeniza `+`, identifica modificadores + tecla principal; se só modificadores (`Control+Super`), ativa `g_useModifiersOnly=TRUE`.

**Lógica do hook**: `UpdateModifierState` + `SyncModifierState` (via `GetAsyncKeyState`, exceto a tecla do evento atual) — corrige estado "preso" por key-up perdido (ex. `Win+L` bloqueia tela, SO não entrega key-up do Win). Auto-cura: se `g_isKeyDown` mas a tecla não está fisicamente pressionada, força `KEY_UP`. Modo modifiers-only: `KEY_DOWN` quando todos pressionados, `KEY_UP` quando algum solta.

#### 3.2.3 `resources/windows-mic-listener.c` — **removido**
Existia para servir `audioActivityDetector.js` (detecção automática de reuniões via atividade "sustentada" de microfone). Removido junto com todo o sistema de detecção automática — ver §3.4.

### 3.3 Backends Nativos de Hotkey Linux

Todos compartilham serviço D-Bus `com.ektoswhispr.App`/path `/com/ektoswhispr/App`, via `@homebridge/dbus-native` (puro JS).

#### 3.3.1 `gnomeShortcut.js`
Registra via `gsettings` custom-keybindings que disparam `dbus-send` chamando método D-Bus. `SLOT_CONFIG`: cada slot tem path gsettings próprio e método D-Bus (`Toggle`, `ToggleAgent`, `ToggleMeeting`, `ToggleVoiceAgent`). `registerKeybinding`: valida formato, monta comando `dbus-send`, verifica conflito com bindings existentes, `gsettings set`. `convertToGnomeFormat`: `Control→<Control>`, `Alt→<Alt>`, `Shift→<Shift>`, `Super/Meta→<Super>`; backtick→`grave`; F-keys uppercase.

#### 3.3.2 `hyprlandShortcut.js`
Só slot `dictation`. `registerKeybinding` via `hyprctl keyword bind`. Combos somente-modificador → último modificador vira tecla-gatilho XKB (`Control_L`/`Super_L`). **Persistência**: escreve bind em `ektoswhispr-binds.conf` (bindings via `hyprctl keyword` são efêmeros, não sobrevivem reload/restart) + garante `source = ./ektoswhispr-binds.conf` no `hyprland.conf`. **Limitação**: push-to-talk não suportado (bind dispara um único exec).

#### 3.3.3 `kdeShortcut.js`
Via KGlobalAccel. Suporta múltiplos slots. Combos somente-modificador **não suportados em X11** (XGrabKey exige keycode real) mas **suportados em Wayland** (KWin trata nativamente). Checagem de conflito pré- e pós-registro via D-Bus. Retorno: `true`/`"conflict"`/`"modifier-only"`/`false`.

### 3.4 Reuniões: gravação manual + histórico da detecção automática removida

#### 3.4.1 `manualMeetingLauncher.js` (antes `meetingDetectionEngine.js`)
Não existe mais detecção automática de reuniões. `src/helpers/meetingDetectionEngine.js` foi renomeado para `src/helpers/manualMeetingLauncher.js` (classe `MeetingDetectionEngine` → `ManualMeetingLauncher`) e reduzido a apenas o fluxo manual: constructor `(windowManager, databaseManager)` (sem os dois detectores), `startManualMeeting()`, `setMeetingModeActive(active)`, `broadcastToWindows(channel, data)`. Toda a máquina de preferências/notificação/fila (`preferences`, `setPreferences`/`getPreferences`, `_handleDetection`, `_showPrompt`, `handleNotificationResponse`, `handleNotificationTimeout`, `_flushNotificationQueue`, `activeDetections`, `_userRecording`/`setUserRecording`, `_postRecordingCooldown`, `start()`/`stop()`) foi removida — ela só existia para servir a notificação "Meeting Detected" que não existe mais. (`joinCalendarMeeting()` também existia aqui como código morto de calendário quando esta remoção começou; foi eliminado por completo na limpeza subsequente de remanescentes de Google Calendar — ver §3.4.5.)

`startManualMeeting()` é acionado pelo hotkey de slot `meeting` (`main.js`): cria uma nota na pasta "Meetings", navega o painel de controle até ela (`windowManager.queueMeetingNoteNavigation`), e a gravação real começa via o bloco IPC "Meeting Transcription" (`meeting-transcription-*`, ver §1.4.1) — o mesmo backend usado por Note Recording (`PersonalNotesView.tsx`/`meetingRecordingStore.ts`).

**⚠️ Nota histórica**: `imminentEvent` era hardcoded `null` no `meetingDetectionEngine.js` original — o lookup de evento de calendário iminente foi removido junto com Google Calendar (ver §0.6), antes e independentemente desta remoção de detecção automática. Após a limpeza subsequente dos remanescentes de Google Calendar (`docs/specs/remove-dead-google-calendar-code.md`), `startManualMeeting()` também perdeu sua branch de delegação para eventos de calendário (junto com `joinCalendarMeeting()` — ver §3.4.5), e `handleNotificationResponse()` (já removido nesta própria mudança, junto com toda a notificação — ver §3.4.6) não computava mais `isRealEvent` antes de deixar de existir.

#### 3.4.2 `meetingProcessDetector.js` — **removido**
Detectava apps de reunião conhecidos (Zoom/Teams/Webex/FaceTime; macOS via `systemPreferences.subscribeWorkspaceNotification`, Windows/Linux via polling `processListCache` a cada 30s). Puramente contextual (só logava, nunca disparava notificação sozinho). Removido por inteiro — não há mais nenhum consumidor de detecção por processo.

#### 3.4.3 `audioActivityDetector.js` — **removido**
Detectava uso "sustentado" de microfone (reuniões não-agendadas, Google Meet) via `macos-mic-listener`/`windows-mic-listener.exe --exclude-pid`/`pactl subscribe` (com fallback para polling), e alimentava a notificação "Meeting Detected". Removido por inteiro, junto com os binários nativos `resources/windows-mic-listener.c`/`resources/macos-mic-listener.swift` e os scripts `scripts/build-macos-mic-listener.js`/`scripts/download-windows-mic-listener.js` e o workflow `.github/workflows/build-windows-mic-listener.yml`.

#### 3.4.4 `processListCache.js` — **removido**
Singleton (TTL 5s, `ps-list`) que só existia para servir `meetingProcessDetector.js`/`audioActivityDetector.js`; removido junto com os dois, verificado sem outros consumidores.

#### 3.4.5 Google Calendar — **removido do código atual**
`googleCalendarManager.js`/`googleCalendarOAuth.js` não existem mais nesta branch (`chore/remove-dead-cloud-code`). `imminentEvent` hardcoded `null` em `meetingDetectionEngine.js`. **Não implementar** essa funcionalidade numa recriação fiel do estado atual.

**Atualização (`docs/specs/remove-dead-google-calendar-code.md`)**: os remanescentes dessa remoção também foram eliminados. `getActiveEvents()`/`getCalendarEventById()` não existem mais em `database.js` (nem os outros 18 métodos mortos de Google Calendar); `joinCalendarMeeting()` não existe mais em `manualMeetingLauncher.js` (antigo `meetingDetectionEngine.js`); `startManualMeeting()` cria a nota manual diretamente, sem branch de delegação; `handleNotificationResponse()`'s `"start"` não computa mais `isRealEvent` (a própria função já não existe — ver §3.4.6). As tabelas `google_calendar_tokens`/`google_calendars`/`calendar_events` foram removidas do schema (`DROP TABLE IF EXISTS` idempotente em `initDatabase()` para instalações existentes). Uma recriação fiel do estado atual não deve incluir nenhum desses métodos, branches, ou tabelas.

#### 3.4.6 "Meeting Detected" — a notificação em si (removida)
A janela/overlay de notificação (`MeetingNotificationOverlay.tsx`/`MeetingNotificationCard.tsx`, rota `?meeting-notification=true`), a plumbing de janela em `windowManager.js` (`showMeetingNotification`, `showNotificationWindow`, `dismissMeetingNotification`, `notificationWindow`, `_pendingNotificationData`, `_notificationTimeout`, `_notificationReadyFallback`), sua superfície IPC (`meeting-detection-get/set-preferences`, `meeting-notification-respond`, `get-meeting-notification-data`, `meeting-notification-ready`, pushes `meeting-detected`/`meeting-detected-start-recording`/`meeting-notification-data`), o toggle de Settings "Meeting Detection" (`notifyMeetingDetection`) e o campo vestigial `meetingProcessDetection` foram todos removidos. O passo de onboarding `meeting`/`MeetingSetupStep.tsx` (já inatingível via `showMeetingStep = false`) também foi removido — ver §6.7.

### 3.5 Voice Agent Hotkey

Hotkey dedicado (slot `voiceAgent`) que dita direto para o dictation agent, sem wake word, sempre ignorando cleanup.

**Fluxo**: hotkey → `windowManager.sendToggleVoiceAgent()` (captura PID da janela-alvo antes) → IPC `toggle-voice-agent` → `useAudioRecording.js` chama `performStartRecording({voiceAgentRequested:true})` → `audioManager.setVoiceAgentRequested(true)` (resetado a `false` em qualquer outro início de gravação normal).

**Roteamento** (`src/helpers/dictationRouting.js`):
```js
resolveDictationRouteKind({cleanupReachable, agentReachable, agentInvoked, voiceAgentRequested}) {
  if (voiceAgentRequested) return agentReachable ? "agent" : "skip";  // NUNCA cai para cleanup
  if (agentReachable && agentInvoked) return "agent";
  if (cleanupReachable) return "cleanup";
  return "skip";
}
```

**Fallback de modelo**: se `voiceAgentRequested && !agentModel && useDictationAgent`, tenta reaproveitar o modelo de cleanup como motor de inferência da rota "agent" (a rota nunca é "cleanup", mas o modelo pode ser); senão usa `chatAgentModel`.

**Persistência**: env var `VOICE_AGENT_KEY` (sem default, opt-in).

### 3.6 Clipboard e Auto-Paste (`src/helpers/clipboard.js`)

#### 3.6.1 Infraestrutura comum
Fila serial de paste (operações concorrentes rodam em série). `_saveClipboard()`/`_restoreClipboardAfterDelay` (só restaura se clipboard não mudou desde então). Detecção de sessão Linux: `isWayland`, `xwaylandAvailable`, `desktopEnv`, `isGnome/Kde/Wlroots/Hyprland`.

#### 3.6.2 macOS
Checa `checkAccessibilityPermissions` (cache TTL 5s). Binário nativo `macos-fast-paste` (CGEvent) preferencial; fallback automático para AppleScript (`osascript ... key code 9 using command down`).

#### 3.6.3 Windows
Cadeia: `windows-fast-paste.exe` (SendInput) → `nircmd.exe sendkeypress ctrl+v` → PowerShell `SendKeys`.

#### 3.6.4 Linux (o caminho mais complexo)
Pré-detecção de janela-alvo (`xdotool getactivewindow`, com fallbacks KDE/Hyprland); detecta se é app Electron (hospeda terminais TUI que interpretam Ctrl+V como colar imagem).

**Escolha de teclas**: `Shift+Insert` se Konsole, Electron, ou Wayland sem classe detectada; terminal detectado → `Ctrl+Shift+V`; caso comum → `Ctrl+V`.

Binário nativo `linux-fast-paste` (XTest) tentado primeiro, exceto Konsole em X11 (bug conhecido, roteado direto para `xdotool`). Wayland: KDE tenta portal primeiro depois uinput (clipboard+input ambos X11 via XWayland); GNOME tenta uinput primeiro depois portal (issue #494: portal do GNOME expira/mostra diálogo confuso). Fallback para ferramentas de sistema, ordenação compositor-aware: X11 → `xdotool`→`ydotool`; wlroots → `wtype`→`xdotool`→`ydotool`; GNOME/KDE → `ydotool`→`xdotool`→`wtype`.

---

## 4. Banco de Dados, Notas e Busca

### 4.1 SQLite (`src/helpers/database.js`)

`DatabaseManager` encapsula toda a persistência via `better-sqlite3`. Caminho: `<userData>/transcriptions.db` (ou `transcriptions-dev.db` em dev). WAL habilitado. **Sem sistema de migrations versionado** — `initDatabase()` roda toda inicialização usando `CREATE TABLE IF NOT EXISTS` + sequência de `ALTER TABLE ADD COLUMN` em `try/catch` (ignora erro "duplicate column") — padrão idempotente "migração by ALTER".

#### 4.1.1 Schema completo

**`transcriptions`**: `id, text, timestamp, created_at` + via ALTER: `raw_text, has_audio, audio_duration_ms, provider, model, status DEFAULT 'completed', error_message, error_code, client_transcription_id (UUID), cloud_id, sync_status DEFAULT 'pending', deleted_at`. Índice único em `client_transcription_id`.

**`custom_dictionary`**: `id, word UNIQUE, created_at` + `client_dict_id, cloud_id, source DEFAULT 'manual' ('manual'|'learned'), sync_status, deleted_at, updated_at`.

**`snippets`**: `id, trigger, replacement, client_snippet_id, cloud_id, sync_status, deleted_at, created_at, updated_at` + `apps TEXT DEFAULT NULL` (JSON array de apps onde restrito). `MAX_SNIPPET_TRIGGER_LENGTH=100`. Índice único em `lower(trigger) WHERE deleted_at IS NULL` (um único trigger ativo por texto, case-insensitive).

**`notes`**: `id, title DEFAULT 'Untitled Note', content, note_type DEFAULT 'personal' ('personal'|'meeting'|'upload'), source_file, audio_duration_seconds, created_at, updated_at` + `enhanced_content, enhancement_prompt, enhanced_at_content_hash, cloud_id, audio_path, folder_id REFERENCES folders(id), transcript, calendar_event_id, participants (JSON), diarization_enabled, expected_speaker_count, client_note_id, sync_status, deleted_at`.

**FTS5 (`notes_fts`)**: tabela virtual `USING fts5(title, content, enhanced_content, content='notes', content_rowid='id')` — external content table, com triggers `AFTER INSERT/UPDATE/DELETE` que mantêm o índice sincronizado (padrão delete-then-insert no UPDATE). Backfill único no boot para bancos existentes.

**`folders`**: `id, name UNIQUE, is_default, sort_order, created_at, updated_at` + colunas de sync. Seed automático: pastas **"Personal"** (sort 0, default) e **"Meetings"** (sort 1, default) na primeira inicialização; notas com `folder_id IS NULL` são retroativamente atribuídas a "Personal".

**`actions`**: `id, name, description, prompt, icon DEFAULT 'sparkles', is_builtin, sort_order, created_at, updated_at` + `translation_key`. Seed de uma ação built-in "Generate Notes"; migração reescreve o prompt built-in se `translation_key` não bate com o esperado (permite atualizar sem duplicar).

**`agent_conversations`**: `id, title DEFAULT 'Untitled', created_at, updated_at` + `archived_at, cloud_id, note_id, client_conversation_id, sync_status, deleted_at`.

**`agent_messages`**: `id, conversation_id REFERENCES agent_conversations(id) ON DELETE CASCADE, role CHECK(IN user/assistant/system), content, created_at` + `metadata (JSON)`.

**`google_calendar_tokens`/`google_calendars`/`calendar_events`**: **removidas** (ver §3.4.5) — `initDatabase()` executa `DROP TABLE IF EXISTS` para as 3 tabelas em toda inicialização (idempotente; no-op em instalações que nunca as tiveram). Não fazem mais parte do schema atual.

**`contacts`**: `email PRIMARY KEY, display_name, created_at, updated_at`.

**`speaker_profiles`**: `id, display_name, email, embedding BLOB (Float32Array), sample_count DEFAULT 1, created_at, updated_at` — embedding "canônico" por pessoa, atualizado por EMA (0.3 novo/0.7 antigo).

**`speaker_mappings`**: `(note_id, speaker_id) PRIMARY KEY, profile_id, display_name` — mapeia speaker de uma transcrição específica a um profile.

**`note_speaker_embeddings`**: `(note_id, speaker_id) PRIMARY KEY, embedding BLOB` — embedding daquela reunião específica antes de mapeado.

#### 4.1.2 Colunas de sincronização (padrão recorrente)
Toda entidade sincronizável (`notes`, `folders`, `agent_conversations`, `transcriptions`, `custom_dictionary`, `snippets`) tem: `client_<entity>_id` (UUID local), `cloud_id`, `sync_status` (`pending|synced|error`), `deleted_at` (tombstone). Backfill no boot preenche `client_*_id` com `randomUUID()` para linhas antigas.

**Regra delete/tombstone**: se `cloud_id IS NULL` → hard delete; se já tem `cloud_id` → soft delete (`deleted_at=now(), sync_status='pending'`).

**Nota**: a infraestrutura de sync com nuvem existe no schema/DB mas está desativada no cliente atual (`noteStore.ts` tem `startMigration()` como no-op comentado "Cloud sync disabled").

#### 4.1.3 Operações principais
CRUD completo por entidade (`saveTranscription`, `setDictionary` com diff completo + promoção `learned→manual`, `saveNote`/`getNotes`/`updateNote`/`deleteNote`/`searchNotes`, `createFolder`/`deleteFolder` (bloqueia default, hard-deleta notas contidas), `createAgentConversation`/`addAgentMessage` (reindexação vetorial incremental), `upsertSpeakerProfile` (fusão por email/nome), `mergeSpeakerProfiles`). Métodos de sync em massa (`getPending*`, `upsert*FromCloud`, `mark*Synced`, `hardDelete*`) para notes/folders/conversations/transcriptions. (Não há mais métodos de Google Calendar — removidos por completo, ver §3.4.5/§4.1.1.)

`cleanup()`: fecha conexão e apaga o arquivo `.db` do disco.

### 4.2 Busca semântica local — removida

Até a remoção documentada em `docs/specs/remove-qdrant-dependency.md`, o app rodava um sidecar
Qdrant (Rust, porta 6333–6350, `~/.cache/ektoswhispr/qdrant-data/`), embeddings de texto locais
via ONNX (`all-MiniLM-L6-v2`, 384-dim, `src/helpers/localEmbeddings.js`), um índice vetorial
(`src/helpers/vectorIndex.js`, duas collections: `notes` e `conversation_chunks`) e um fluxo
híbrido FTS5 + busca vetorial combinado por Reciprocal Rank Fusion (K=60) no handler IPC
`db-semantic-search-notes`. Havia também um caminho de busca semântica de conversas
(`db-semantic-search-conversations`) que, por um bug de longa data (`this.vectorIndex` nunca era
atribuído em `ipcHandlers.js`), **nunca esteve realmente ativo** — sempre caiu silenciosamente para
`searchAgentConversations()` (FTS5) em todo build já lançado.

Todo esse subsistema foi removido: `qdrantManager.js`, `localEmbeddings.js`, `vectorIndex.js`,
`conversationChunker.js`, os scripts `download-qdrant.js`/`download-minilm.js`, a dependência
`@qdrant/js-client-rest`, e os handlers IPC `db-semantic-search-notes`,
`db-semantic-reindex-all`, `db-semantic-search-conversations`. `search_notes` (ferramenta do
agente) e a busca de conversas do agente agora usam **apenas** `databaseManager.searchNotes()` /
`searchAgentConversations()` (FTS5/BM25 nativo do SQLite) — busca por palavra-chave, sem
compreensão semântica de sinônimos ou paráfrases. Uma limpeza única e best-effort
(`src/helpers/qdrantDataCleanup.js`, sentinela `.qdrant-removed` em `userData`) apaga
`~/.cache/ektoswhispr/qdrant-data/` e `~/.cache/ektoswhispr/embedding-models/` para quem atualiza
de uma versão anterior. Ver a spec para o raciocínio completo, incluindo a decisão de também
remover a entrada `qdrant` de `EXPECTED_BINARY_FRAGMENTS` em `sidecarReaper.js` (§1.9.3).

#### 4.2.1 Worker ONNX dedicado (`src/workers/onnxWorker.js` + `onnxWorkerClient.js`)
Toda inferência ONNX roda em **utility process** separado (isola crashes nativos do processo
principal) — infraestrutura compartilhada, preservada pela remoção acima porque também hospeda os
embeddings de locutor (diarização), que continuam em uso.

- `onnxWorkerClient.js`: `utilityProcess.fork` + `MessageChannelMain`. `REQUEST_TIMEOUT_MS=30000`. `MAX_PENDING_REQUESTS=1000` (descarta a mais antiga). **Crash/respawn com backoff**: `RESPAWN_BACKOFF_MS=[1000,2000,4000,8000,16000,30000]`; após `MAX_RESPAWN_ATTEMPTS=5`, desiste (`gaveUp=true`).
- `onnxWorker.js`: handler `speaker.load/extract` (fbank Mel manual, FFT radix-2, até 8s de áudio) — usado por `src/helpers/speakerEmbeddings.js` para diarização/mapeamento de falantes. Os handlers `text.load`/`text.embed` (tokenizador WordPiece, mean pooling + normalização L2) existiam apenas para os embeddings de notas do Qdrant e foram removidos junto com o resto do subsistema.

### 4.3 `searchNotesTool.ts` — Ferramenta de Busca do Agente

Uma única estratégia: `executeLocalSearch(query, limit)` chama `window.electronAPI.searchNotes(query, limit)` (FTS5 puro) diretamente, sem fallback chain nem RRF. `MAX_CONTENT_LENGTH=500` chars, prioriza `enhanced_content`. O parâmetro `useCloudSearch`/`SearchToolOptions` continua recebido mas não usado — órfão pré-existente, não relacionado à remoção do Qdrant (esse fork não tem backend de busca em nuvem).

Outras tools de notas: `list_folders`, `get_note`, `create_note` (resolve/cria pasta se necessário, dispara `syncService.debouncedPush`), `update_note` (exige `id`, não busca por título).

### 4.4 IPC de Notas e Conversas

Ver tabela consolidada em §1.4.1. Toda escrita em `notes` replica para o "espelho Markdown" (se habilitado) — best-effort, assíncrono.

### 4.5 Componentes de Notas (UI)

- **`PersonalNotesView.tsx`**: `handleNewNote()` cria nota vazia na pasta ativa; diálogo permite escolher pasta de destino (com criação inline).
- **`UploadAudioView.tsx`**: máquina de estados `idle→selected→transcribing→complete/error`. Título gerado por IA (se habilitado) ou primeiras 6 palavras/nome do arquivo. Limite de 25MB só para provedores BYOK cloud não-"custom"; local/custom sem limite. Diarização só se Parakeet local + modelos já baixados.
- **`NoteEditor.tsx`**: 3 modos (`raw`/`transcript`/`enhanced`). Transcript mostra segmentos com diarização, mapeamento de speaker, retranscrição com progresso. Chat embutido contextualizado pela nota. Exportação md/txt/srt/json.

---

## 5. IA / Reasoning / Agente

**⚠️ Divergência confirmada com CLAUDE.md**: não existe um provider "ektoswhispr". O conceito de "EktosWhispr Cloud" está desativado — todos os `selectIsCloud*Mode` retornam `false` hardcoded, `streamFromIPC` lança `"Cloud agent streaming is not available in this version"`. Os 7 providers reais: `openai`/`custom`/`openrouter` (1 handler), `anthropic`, `gemini`, `groq`, `local`, `bedrock`/`azure`/`vertex` (1 handler "enterprise"), `lan`. Também não existe `src/config/aiProvidersConfig.ts` — a derivação equivalente é `buildReasoningProviders()` em `src/models/ModelRegistry.ts`.

### 5.1 Arquitetura Geral

```
UI (SettingsPage, ChatInput) → settingsStore.ts (Zustand)
   → ReasoningService.ts (singleton) → PROVIDER_REGISTRY (inferenceProviders/index.ts) → cada provider
   → AI SDK (Vercel `ai`) para streaming com tool-calling → providers.ts/enterpriseChatModel.ts
   → src/services/tools/* (ferramentas do agente)
   → src/config/prompts/* (templates de system prompt)
   → src/helpers/dictationRouting.js (decide agent/cleanup/skip)
```

Dois motores de execução: (1) `fetch` cru + SSE manual (cleanup/ditado, streaming só para `local`); (2) Vercel AI SDK `streamText` (chat do agente com tool-calling, `stepCountIs(20)`).

### 5.2 `ReasoningService.ts`

Singleton estendendo `BaseReasoningService`. Cache de API keys (`SecureCache`) com limpeza automática; `getApiKey(provider)` — `"custom"` via IPC dedicado, demais via `get<Provider>Key()` cacheado; lança erro `.code="API_KEY_MISSING"` se ausente.

#### 5.2.1 `callChatCompletionsApi` (helper compartilhado, formato OpenAI-compatível)
`isCleanup = !config.systemPrompt` → `temperature=0`, texto envolvido em `wrapCleanupTranscript()` (`<transcript>...</transcript>\n\nOutput only the cleaned transcript.`). Com `systemPrompt` (agente) → `temperature≈0.3`, texto cru. `max_tokens = config.maxTokens || max(4096, calculateMaxTokens(...))`. **Regra gpt-oss**: cleanup + modelo `gpt-oss` → `reasoning_effort="low"`. `applyThinkingSuppression()` (§5.7). Retry com backoff (`withRetry`, 3 tentativas). Resposta vazia → erro.

#### 5.2.2 `processText` — ponto de entrada não-streaming
Resolve `providerId`: `config.lanUrl`/self-hosted → força `"lan"`; senão `config.provider` ou `getModelProvider(model)`. Fallback de segurança: se provider resolvido não existe em `PROVIDER_REGISTRY`, re-deriva via `getModelProvider` (garante GGUF local sempre cair em `"local"`).

#### 5.2.3 `processTextStreamed` — streaming só para modelo local
Só ativa streaming quando `providerId==="local"` e há `onPartial`; senão bloqueante. Erro antes de conteúdo parcial → fallback silencioso para `processText`; erro após conteúdo parcial → relança.

#### 5.2.4 `processTextStreaming` (SSE bruto, ditado local)
Resolve endpoint (LAN/local via `llamaServerStart`/cloud). `useOldTokenParam = isLocalProvider || isLanCleanup || provider==="groq"`. **Parâmetros de sampling locais**: sobrescreve `temperature/max_tokens/top_p/top_k/min_p/repeat_penalty` com `getLocalGenerationParams()` sempre (configurável pelo usuário, aplicado independente do GGUF selecionado). **Filtro de "thinking"** (`<think>...</think>`) removido token a token se `disableThinking !== false` para local/LAN. Timeout 60s, cancelável via `cancelActiveStream()`.

#### 5.2.5 `processTextStreamingAI` (AI SDK, chat do agente com tools)
`isEnterprise = !lanOverride && isEnterpriseProvider(provider)`. Se local/LAN sem tools → delega para `processTextStreaming`. Enterprise → `createEnterpriseChatModel` (proxy IPC completo). Local → `llamaServerStart` + baseURL local. Cloud → resolve key/baseURL.

**Provider options de "no thinking"**: `groq` → `{reasoningEffort:"none"}`; `gemini` → `{thinkingConfig:{thinkingLevel:"minimal", includeThoughts:false}}`; `openrouter` → via `withDisabledReasoning` wrapper de fetch.

`streamText({model, messages, tools, stopWhen: stepCountIs(tools?20:1), abortSignal, ...})`. Mapeia chunks: `text-delta`→`content`, `tool-call`→`tool_calls`, `tool-result`→`tool_result`, `finish`→`done`.

#### 5.2.6 `processTextStreamingCloud`/`streamFromIPC` — **morto/desabilitado**
`streamFromIPC` sempre lança erro. `isCloudAgent` sempre `false`. **Não implementar numa recriação.**

#### 5.2.7 `isAvailable()`
Cascata: LAN configurado → custom endpoint → enterprise (checagem local de credenciais) → alguma BYOK key presente → modelo local baixado.

#### 5.2.8 Detecção de wake word — `src/config/agentDetection.ts`
`detectAgentName(transcript, agentName)`. **Tolerância fonética**: Levenshtein com limite escalado (`≤4 chars→0 edições; ≤6→1; mais longo→2`). Janelas deslizantes para nomes com múltiplas palavras (cobre STT que divide "OpenWhispr" em "open whispr"). `isAddressedAt(index,...)`: só conta como comando (não menção incidental) se o nome está no início da frase, precedido por vocative cue (`hey, hi, ok, please`), ou precedido por pontuação de fim de frase.

A remoção do nome do agente do output final **não** é determinística no código — é resolvida via prompt-engineering (o system prompt instrui o modelo a não repetir o nome de invocação).

### 5.3 Providers (`src/services/ai/inferenceProviders/`)

`ProviderContext` injeta `getApiKey`, `getSystemPrompt`, `getCustomDictionary`, `getPreferredLanguage`, `callChatCompletionsApi`, `calculateMaxTokens` em cada provider — desacopla providers do singleton `ReasoningService`.

`PROVIDER_REGISTRY` (`Object.freeze`): `openai/custom/openrouter → openaiProvider`; `anthropic → anthropicProvider`; `gemini → geminiProvider`; `groq → groqProvider`; `local → localProvider`; `bedrock/azure/vertex → enterpriseProvider`; `lan → lanProvider`.

- **`anthropic.ts`**: delega 100% via IPC (`processAnthropicReasoning`) — evita CORS no renderer.
- **`enterprise.ts`**: handler comum Bedrock/Azure/Vertex, delega via IPC (`processEnterpriseReasoning`) com credenciais empacotadas por `getEnterpriseCallSettings(provider)`. Streaming enterprise usa `enterpriseChatModel.ts` (shim `LanguageModelV3` que faz proxy via `enterpriseStreamStart`/eventos `enterpriseStreamPart`).
- **`gemini.ts`**: único que fala protocolo nativo (`generateContent`, não Chat Completions) — `contents:[{parts:[{text: system+user concatenados}]}]` (sem mensagens separadas). Tratamento especial de `finishReason==="MAX_TOKENS"` com mensagem amigável distinta de resposta vazia genérica.
- **`groq.ts`**: delega 100% para `callChatCompletionsApi` (`GROQ_BASE="https://api.groq.com/openai/v1"`).
- **`lan.ts`** (self-hosted): `ensureV1Suffix`, `resolvedModel = model?.trim() || "default"` (muitos servidores locais ignoram o campo model).
- **`local.ts`**: via IPC (`processLocalReasoning`) — sempre sobrescreve sampling com `getLocalGenerationParams()`.
- **`openai.ts`** (usado para `openai`/`custom`/`openrouter`): o mais complexo — **detecção automática Responses API vs Chat Completions** (`getEndpointCandidates`, memoriza preferência por base URL em `localStorage["openAiEndpointPreference"]`; probe `GET {base}/models`, se `owned_by==="llamacpp"` memoriza `"chat"`). Parse de resposta multi-formato: Responses API → `output[]` → `output_text` → Chat Completions `choices[].message.content` → **fallback: retorna o texto original sem alterações** (nunca quebra o pipeline por resposta vazia).

### 5.4 `src/config/inferenceScopes.ts` — os 4 escopos

```ts
INFERENCE_SCOPES = {
  dictationCleanup: {storeKeys: {mode:"cleanupMode", provider:"cleanupProvider", model:"cleanupModel", ...}},
  dictationAgent:  {storeKeys: {...prefixo dictationAgent...}, fallbackScope:"dictationCleanup"},
  noteFormatting:  {storeKeys: {...prefixo noteFormatting...}, fallbackScope:"dictationCleanup"},
  chatIntelligence:{storeKeys: {...prefixo chatAgent...}},  // sem fallback
}
```
- **`dictationCleanup`**: limpeza do texto ditado bruto (raiz da cadeia de fallback).
- **`dictationAgent`**: acionado por wake word ou hotkey Voice Agent. Cai para `dictationCleanup` se não configurado.
- **`noteFormatting`**: formatação/título de notas de reunião. Cai para `dictationCleanup`.
- **`chatIntelligence`**: chat do agente, sem fallback.

### 5.5 `src/stores/settingsStore.ts` — a store central (Zustand)

Persistência primária `localStorage`, exceto 12+ secrets (via `safeStorage`/keychain no main, hidratados por IPC).

#### 5.5.1 Migrações one-time (rodam no import do módulo)
`migrateMeetingFollowFlags`, `migrateProviderSettings` (deriva `InferenceMode` de campos legados), `migrateUploadTranscription`, `migrateAgentMode`, `migrateCustomPrompts`, `migrateLLMScopeKeys` (~19 chaves antigas renomeadas: `reasoningModel→cleanupModel`, `agentModel→chatAgentModel`, `meetingReasoningModel→noteFormattingModel`, etc.) — o esquema atual de 4 escopos substituiu um esquema mais antigo de 2 conceitos.

#### 5.5.2 `InferenceMode`
`"providers"` (BYOK) | `"local"` (GGUF) | `"self-hosted"` (LAN) | `"enterprise"` (bedrock/azure/vertex).

#### 5.5.3 Secrets (12+)
`createSecretSetter`: atualiza estado imediato → `debouncedSaveSecret` (250ms) → IPC saver → `invalidateApiKeyCaches` → `debouncedPersistToEnv` (1s) → `saveAllKeysToEnv`. `STALE_SECRET_LOCALSTORAGE_KEYS` apagadas ativamente a cada `initializeSettings()`.

#### 5.5.4 `selectResolvedLLMConfig(state, scope)` — coração do fallback
```ts
const selectResolvedLLMConfig = (state, scope) => {
  const fallback = def.fallbackScope ? selectResolvedLLMConfig(state, def.fallbackScope) : undefined;  // recursivo
  const useSharedLocal = mode === "local" && !!state.localModel;
  return {
    provider: useSharedLocal ? state.localProvider : (read("provider") || fallback?.provider || ""),
    model:    useSharedLocal ? state.localModel    : (read("model")    || fallback?.model    || ""),
    ...
  };
};
```
**Modo `"local"` usa um único modelo GGUF compartilhado** entre todos os escopos (não um `llama-server` por escopo). Cadeia de fallback recursiva declarativa via `INFERENCE_SCOPES`.

#### 5.5.5 `getLocalGenerationParams()`
`{temperature, topP, topK, minP, repeatPenalty, maxTokens}`. Defaults: `temperature=0.3, topP=0.9, topK=40, minP=0.05, repeatPenalty=1.1, maxTokens=4096`. Únicos parâmetros manuais globais para inferência local, aplicados independente do escopo/modelo.

#### 5.5.6 `initializeSettings()`
Hidrata 14 secrets via IPC em paralelo, limpa chaves stale, sincroniza `startMinimized`/`dictationKey`/hotkeys/`activationMode`/`uiLanguage` a partir do `.env` do main (segunda fonte de verdade), registra listener `window "storage"` para propagar entre janelas.

### 5.6 Registro de Modelos

#### 5.6.1 `src/models/modelRegistryData.json` — fonte única de verdade
```json
{parakeetModels, whisperModels, transcriptionProviders, cloudProviders, enterpriseProviders, localProviders, ektoswhisprCloudModels}
```
`ektoswhisprCloudModels` é **vestigial** (ver §0.4). `cloudProviders`: openai (gpt-5.6/5.5/5.2/mini/nano, gpt-4.1 série), anthropic (claude-fable-5, claude-sonnet-5/4-6, claude-haiku-4-5, claude-opus-4-8/4-7/4-6, etc.), gemini (gemini-3.5-flash, 3.1-pro-preview, 3-flash-preview, 2.5-flash-lite, gemma-4), groq (qwen3-32b, gpt-oss-120b/20b, llama-3.3-70b, kimi-k2, etc.). `enterpriseProviders`: bedrock/azure/vertex.

`localProviders` (GGUF, cada um com `promptTemplate` próprio):
- **`qwen`**: ChatML.
- **`mistral`**: `[INST] {system}\n\n{user} [/INST]`.
- **`llama`**: formato Llama-3 (`<|begin_of_text|>...`).
- **`deepseek`**: ChatML.
- **`gemma`**: `<bos><start_of_turn>user...` (sem role system nativo).

Todos com `hfRepo` → URL de download `{baseUrl}/{hfRepo}/resolve/main/{fileName}`.

#### 5.6.2 `src/models/ModelRegistry.ts`
Registra só `localProviders` (Map, `formatPrompt` via template). Cloud/enterprise lidos direto do JSON.

`buildReasoningProviders()` — **equivalente ao "AI_MODES" do CLAUDE.md** — agrega cloud+enterprise+um bucket sintético `"local"` com todos os modelos GGUF.

`getModelProvider(modelId)`: prioriza `cleanupProvider` se `"custom"`/`"openrouter"`/enterprise; senão procura no registro; heurísticas por substring (`claude`→anthropic, `gemini` sem `gemma`→gemini, `gpt-4/5` sem `gpt-oss`→openai, `qwen/llama/mistral`→local); fallback final `"openai"`.

`getOpenAiApiConfig(modelId, provider)`: decide `tokenParam` (`max_tokens` vs `max_completion_tokens`) e `supportsTemperature` por heurística de prefixo do modelo.

#### 5.6.3 Prompts (`src/config/prompts/`)
`PROMPT_KINDS = {cleanup, dictationAgent, chatAgent}`. `resolvePrompt(kind, opts)`: prompt customizado do usuário `|| getDefaultPromptText`; `applySubstitutions` injeta `{{agentName}}`, instrução de idioma, sufixo de dicionário. `wrapCleanupTranscript`. `getAgentSystemPrompt` monta prompt do chat do agente + instruções por tool + bloco de notas relevantes (RAG).

**Nota histórica**: `get_calendar_events` tinha instrução em `TOOL_INSTRUCTIONS` e ícone em `toolIcons.ts` mas nunca houve tool registrada — planejada/removida, nunca funcional. Removido por completo (`docs/specs/remove-dead-google-calendar-code.md`), junto com as chaves de locale órfãs `chat.tools.get_calendar_eventsStatus`/`calendarEvents`/`calendarEvents_plural` (`en`/`pt`) e o bloco `integrations.*` (pt-only) que não tinha nenhuma referência em código.

### 5.7 Supressão de "thinking" (`src/services/ai/thinkingSuppression.ts`)

`applyThinkingSuppression`: se modelo tem `disableThinking` flag no registro (Groq `gpt-oss`) → sempre suprime. Senão, só age se usuário pediu (`config.disableThinking===true`) e o modelo suporta thinking. `suppressThinking`: `gemini`→`reasoning_effort:"minimal"`; `openrouter`→`reasoning:{enabled:false}`; senão dialeto Ollama (`local`/`lan` sem override)→`think:false`, ou dialeto OpenAI-compatible estrito (Groq/LM Studio/vLLM)→`reasoning_effort:"none"`. Sempre também `chat_template_kwargs:{enable_thinking:false}` (necessário para templates Qwen).

### 5.8 Roteamento de Ditado (`src/helpers/dictationRouting.js`)

Ver fórmula completa em §3.5. `resolveDictationAgentReachability`: `false` se toggle desligado; `true` se cloud/self-hosted (sem exigir modelo explícito); senão exige `dictationAgentModel` não-vazio.

### 5.9 Ferramentas do Agente (`src/services/tools/`)

`ToolRegistry.ts`: `{name, description, parameters (JSONSchema), readOnly, execute}`. `toAISDKFormat()` adapta para `ai` (Vercel AI SDK), captura exceções (nunca rejeita a Promise).

6 tools reais: `search_notes` (§4.3), `get_note`, `create_note` (resolve pasta, `syncService.debouncedPush`), `update_note`, `list_folders` (chamar antes de create/update quando pasta envolvida), `copy_to_clipboard`, `web_search` (via IPC `agentWebSearch`, implementação main não coberta).

**Controle de disponibilidade**: `LOCAL_TOOL_MIN_PARAMS_B=4` — modelos locais com &lt;4B parâmetros não recebem tools (`estimateModelSizeB` via regex no id do modelo).

### 5.10 UI do Agente/Chat (`src/components/agent/*`, `src/components/chat/*`)

`agent/*` são wrappers finos sobre `chat/*`. `AgentState`: `idle|listening|transcribing|thinking|streaming|tool-executing`. `ChatInput.tsx` renderiza indicadores por estado (waveform, recording pulsante). `ChatMessage.tsx`: bolhas com `ToolCallStep` expansível, `extractNoteCards` (cards clicáveis de notas criadas/atualizadas/lidas).

`useChatStreaming.ts`: **RAG automático** — `buildRAGContext` chama `searchNotes` (FTS5 keyword — pós-remoção do Qdrant, ver §4.2) antes de cada envio, injeta blocos `<note id="..." title="...">` no system prompt (RAG passivo complementar ao tool-calling ativo). Contexto limitado às últimas 20 mensagens.

### 5.11 Modelos Locais GGUF e llama.cpp

#### 5.11.1 Download do binário (`scripts/download-llama-server.js`)
Repo `ggml-org/llama.cpp`, tag fixa `b9763`. Só variantes CPU aqui (`darwin-arm64/x64`, `win32-x64-cpu`, `linux-x64-cpu`).

#### 5.11.2 Backends de GPU sob demanda (`llamaBackends.js`)
4 backends independentes: `CpuBackend` (bundled), `VulkanBackend` (`userData/bin/`, `--n-gpu-layers 99`, pinning de device multi-GPU via `--list-devices`), `CudaBackend` (`CUDA_DEVICE_ORDER=PCI_BUS_ID` + `CUDA_VISIBLE_DEVICES=INTELLIGENCE_GPU_UUID`), `MetalBackend` (bundled macOS).

**Cadeia de fallback**: `darwin→[Metal]`; `"cpu"→[CPU]`; `"gpu-intel"→[Vulkan,CPU]`; `"gpu-nvidia"/"auto"→[CUDA,Vulkan,CPU]`. `llamaServer.js` filtra por `isAvailable()` e tenta cada backend em ordem — degradação graciosa automática.

#### 5.11.3 `llamaServer.js`
Porta **8221–8240**. Health check `/health` a cada 5s. **Idle timeout configurável** (`setIdleTimeoutMs(ms)`, padrão 5 minutos = `DEFAULT_IDLE_TIMEOUT_MS`, alimentado pela setting `llmIdleTimeoutMs` — ver `docs/specs/on-demand-model-lifecycle.md`) — para automaticamente (libera VRAM). `inference()`: POST `/v1/chat/completions` `stream:false`, timeout 300s, coerção explícita `Number(...)` em parâmetros numéricos. Saída inesperada do processo (`close` com `_intentionalStop === false`) é logada distintamente em nível `error`; nenhum respawn automático é agendado.

#### 5.11.4 `modelManagerBridge.js`
`~/.cache/ektoswhispr/models`. `downloadModel`: valida espaço em disco, `AbortSignal` cancelável, revalida tamanho mínimo pós-download. `prewarmServer(modelId)` **não é mais chamado no startup** (removido de `main.js` — ver `docs/specs/on-demand-model-lifecycle.md` R1); a função permanece disponível como alvo de implementação dos warm-up hooks on-demand (hotkey-down/file-select).

### 5.12 Decisões-Chave para Recriação

1. Nunca implementar provider "ektoswhispr" separado.
2. Dois motores paralelos de chamada LLM (fetch+SSE manual vs. AI SDK `streamText`).
3. 4 escopos com cadeia de fallback declarativa resolvida por uma função genérica.
4. Modo `local` compartilha um único modelo/servidor entre todos os escopos.
5. Backends de GPU são plugins independentes com fallback em cadeia.
6. Regra "cleanup vs agente": ausência de `systemPrompt` = fluxo determinístico de limpeza (`temperature=0`).
7. Wake word com tolerância a erros de STT (Levenshtein escalado + regras de endereçamento).
8. Tratamento de resposta vazia difere por provider: Gemini distingue `MAX_TOKENS`; OpenAI faz fallback silencioso (retorna texto original); demais lançam erro genérico.

---

## 6. Interface React (UI)

### 6.1 Visão Geral

Duas janelas Electron renderizam o mesmo bundle React, roteando via query string (`src/AppRouter.jsx`): **janela de ditado** (`src/App.jsx`), **painel de controle** (`src/components/ControlPanel.tsx`), **onboarding** (`src/components/OnboardingFlow.tsx`, controlado por `localStorage.onboardingCompleted`), **pós-migração** (`src/components/PostMigrationOnboarding.tsx`, modal único macOS).

### 6.2 Janela de Ditado — `src/App.jsx`

Botão flutuante circular, sempre "on top". `getMicState()` calcula estado derivado por prioridade: `recording` → `processing` → `transforming` → `hover` → `idle`. Cada estado tem classe CSS/ícone próprios (`SoundWaveIcon`, `LoadingDots`, `VoiceWaveIndicator`, `TransformIcon`).

**Interações**: clique simples (threshold 5px sem arrasto) → `toggleListening()`; botão de cancelar (X) aparece no hover durante recording/processing; clique direito abre command menu (Start/Stop, Hide for now); Esc fecha menu ou esconde janela; arrasto via `useWindowDrag`.

**Redimensionamento dinâmico**: `resizeMainWindow(mode)` com 4 modos (`BASE/WITH_MENU/WITH_TOAST/EXPANDED`) conforme menu/toast abertos.

**Posição**: `panelStartPosition` (`bottom-left`/`center`/`bottom-right` default).

**Auto-hide**: se `floatingIconAutoHide` e nada em andamento, some após 500ms.

**Toasts/listeners IPC**: `onHotkeyFallbackUsed`, `onHotkeyRegistrationFailed`, `onCorrectionsLearned` (com Undo), `onTransformActivated`/`onRunTransform` (executa a chamada LLM no renderer, devolve via `sendTransformResult`), `onCancelHotkeyPressed`.

### 6.3 Painel de Controle — `src/components/ControlPanel.tsx`

**Views** (`ControlPanelView`): `home | personal-notes | dictionary | snippets | upload | transform`. Sidebar (`ControlPanelSidebar.tsx`) com ícones Lucide; cada view (exceto home) é `React.lazy`. `⌘K`/`Ctrl+K` abre `CommandSearch`; `⌘,`/`Ctrl+,` abre Settings.

**Layout "side panel"**: em modo reunião ou janela estreita+nota aberta, sidebar colapsa e mostra botão de voltar.

**Fluxos no `ControlPanel`**: histórico de transcrições (copiar/deletar/limpar/retry), banner de GPU (CUDA/Vulkan disponível não baixado, dispensável), `PostMigrationOnboarding` (macOS), acessibilidade ausente → abre Settings, updater com toasts.

### 6.4 `SettingsModal.tsx` / `SettingsPage.tsx`

Seções atuais: `general | hotkeys | speechToText | llms | localModel | privacyData | system`, agrupadas em App/AI Models/System. `SECTION_ALIASES`/`LEGACY_SUB_TAB` mapeiam nomes antigos.

#### 6.4.1 Seção `general`
Appearance (tema light/dark/auto), Sound Effects, Notifications, Clipboard, Save Notes as Files, Floating Icon, Language (UI + transcrição, chaves separadas), Startup (auto-start, start minimized), Microphone, Auto-learn, Wayland Paste Diagnostics (Linux).

#### 6.4.2 Seção `hotkeys`
Dictation Hotkey (`HotkeyListInput`, múltiplos bindings exceto native shortcut), aviso Hyprland se config não gravável, Voice Agent Hotkey (opt-in), Meeting Mode Hotkey + layout selector, validação cruzada de conflitos.

#### 6.4.3 Seção `speechToText`
3 sub-abas: `dictation`/`noteRecording`/`upload`. `TranscriptionSection`: `InferenceModeSelector` (providers/local/self-hosted). VAD compartilhado entre dictation/noteRecording (6 campos numéricos com popover de ajuda + reset).

#### 6.4.4 Seção `llms`
4 sub-abas = os 4 escopos. `InferenceConfigEditor` genérico parametrizado por `scope`, 4 modos (`providers/local/self-hosted/enterprise`) com labels específicos por scope.

#### 6.4.5 Seção `localModel`
`LocalModelSection`: seletor de backend GPU, indicador de modelo ativo, picker de modelos, parâmetros de geração (temperature/topP/topK/minP/repeatPenalty/maxTokens) com sliders sincronizados.

#### 6.4.6 Seção `privacyData`
Audio Retention (0/1/7/14/30/60/90 dias), Data Retention, Permissions (`PermissionCard` mic/accessibility[macOS]/system-audio[opcional]).

#### 6.4.7 Seção `system`
Developer, Data Management (limpar cache de modelos, backup/restore completo, reset app data).

### 6.5 `TranscriptionModelPicker.tsx`

Componente único reutilizável (onboarding + settings). Modo Cloud: abas por provider (OpenAI/Groq/xAI/Mistral/Custom), campos de credencial. Modo Local: abas `whisper`(rotulado "OpenAI" na UI!)/`nvidia`, `LocalModelCard` por modelo com estado (ativo/baixado/baixando/não baixado), ações Activate/Download/Cancel/Delete.

### 6.6 Transforms (`src/components/transforms/*`)

Atalhos configuráveis que aplicam reescrita via LLM sobre texto selecionado em qualquer app. Máximo **10 transforms**. `TransformEditor`: hotkey (`HotkeyCapture` customizado, usa `e.code` para independência de layout), 5 regras booleanas (concise/clarity/readability/structure/remove-frustration), contexto (incluir app ativo, rich text output), prompt customizado. Modelo: `{id, name, description, hotkey, enabled, rules, customPrompt, includeActiveApp?, richText?}`, persistido em `localStorage["transforms"]`, sincronizado ao main via `syncTransforms`.

### 6.7 OnboardingFlow — `src/components/OnboardingFlow.tsx`

**⚠️ Divergência confirmada com CLAUDE.md**: não são 8 passos fixos, e não há passo de "agent naming" dedicado (nome do agente só em Settings, default `"EktosWhispr"`).

**Passos reais** (dinâmico): `language → setup (transcrição) → languageModel → localModel (condicional, só se cleanupMode==="local") → permissions → activation (hotkey) → finish`. O passo `meeting` (e o componente `MeetingSetupStep.tsx` que ele renderizava, já inatingível via `showMeetingStep=false`) **não existe mais no código** — foi removido junto com a detecção automática de reuniões (ver §3.4).

- **`setup`**: força modo local ao entrar (`setUseLocalWhisper(true)`); ao sair, espelha a seleção para escopos meeting/upload.
- **`languageModel`**: ao sair, copia config resolvida para `dictationAgent`/`noteFormatting`/`chatIntelligence`.
- **`activation`**: auto-registra hotkey padrão na primeira vez; área de teste de ditação ao vivo.
- **`finish`**: toggles Auto-start/Start minimized; `saveSettings()` força `transcriptionMode`/`meetingTranscriptionMode`/`uploadTranscriptionMode="local"`, marca `onboardingCompleted`, `markBundleMigrated()`, dispara download em background de modelos padrão (whisper "base", LLM local "qwen3.5-2b-q4_k_m").

`src/components/onboarding/UseCaseStep.tsx` existe mas não é importado em nenhum lugar — código morto.

### 6.8 `PostMigrationOnboarding.tsx`

Modal simples (não wizard), reconcede permissões após mudança de bundle ID (macOS). "Remind me later" → `markBundleMigrationDismissed()` (reaparece depois); "Done" → `markBundleMigrated()` (nunca mais).

### 6.9 Hooks (`src/hooks/*`)

- **`useSettings.ts`**: Context Provider sobre a store Zustand; `initializeSettings()` no mount; sincroniza preferências de pré-aquecimento de modelos (só envia modelo local se o toggle correspondente estiver ativo E modo `"local"`).
- **`useLocalStorage.ts`**: wrapper genérico, grava default imediatamente na primeira leitura (para leituras diretas fora do React verem o valor).
- **`useHotkey.js`**: `hotkey = activeDictationKey || dictationKey || getDefaultHotkey()`.
- **`usePermissions.ts`**: mic/accessibility com mensagens de erro traduzidas por tipo/plataforma; Windows/Linux auto-concedem accessibility quando aplicável.
- **`useClipboard.ts`**, **`useDialogs.ts`** (confirm/alert reutilizáveis), **`useWhisper.ts`**.

### 6.10 Chaves de `localStorage` — Tabela de Referência (código real, não CLAUDE.md)

**⚠️ Ver §0.8** para as divergências resumidas. Chaves confirmadas no código: `whisperModel`, `useLocalWhisper`, `customDictionary`, `agentName` (default `"EktosWhispr"`), **`dictationKey`** (não `hotkey`), **`onboardingCompleted`** (não `hasCompletedOnboarding`), `uiLanguage` + **`preferredLanguage`** (duas chaves separadas, não uma única `language`), `activationMode`, `meetingKey`/`meetingHotkeyLayoutMode`, `transforms`/`snippets`, `onboardingUseCases`, `theme`, `audioRetentionDays`/`dataRetentionEnabled`, `floatingIconAutoHide`/`startMinimized`/`panelStartPosition`, campos de VAD/diarização/AEC, `micGain`, `localTranscriptionProvider` (+ variantes meeting/upload), campos enterprise (Bedrock/Azure/Vertex), `onboardingCurrentStep`, `micPermissionGranted`/`accessibilityPermissionGranted`, `autoLearnCorrections`, `settings.speechToTextTab`/`settings.llmsTab`.

**Nota**: `reasoningProvider`/`reasoningModel` existem só como chaves de migração legada (não são mais lidas/escritas ativamente — substituídas por `cleanupProvider`/`cleanupModel`).

---

## 7. Build, Empacotamento e Recursos Nativos

### 7.1 Visão Geral do Projeto

Nome npm `ektos-whispr`, appId `com.gizmolabs.ektoswhispr`, productName `EktosWhispr`. `engines.node >= 26`; `.nvmrc` fixa **Node 26** (⚠️ CLAUDE.md menciona Node 24 — desatualizado, usar 26 como fonte da verdade). Nenhum `.env.example` existe — variáveis de ambiente devem ser inferidas do código.

### 7.2 `package.json` — Dependências Arquiteturalmente Relevantes

**Dev**: `electron@^43`, `electron-builder@^26`, `@electron/notarize`, `vite@^8`, Tailwind v4, TypeScript, ESLint/Prettier, `concurrently`, `cross-env`.

**Runtime**: `electron-updater`, `better-sqlite3` (DB local), `ffmpeg-static` (precisa `asarUnpack`), `onnxruntime-node` (utility process separado — usado hoje só para embeddings de locutor/diarização, ver §4.2.1), `ps-list` (traz executável vendor Windows), `ws`, `@homebridge/dbus-native` (D-Bus puro JS), `@napi-rs/keyring` (keychain/DPAPI/libsecret, `asarUnpack`), React 19, Zustand, Kysely, Zod, Tiptap (editor rich-text), SDKs de IA (`@ai-sdk/*`, `ai`, `@aws-sdk/client-bedrock`). `@qdrant/js-client-rest` foi removida (ver `docs/specs/remove-qdrant-dependency.md`).

### 7.3 Scripts npm — Ordem de Execução

**Compilação nativa**: `compile:native` = `compile:globe && compile:fast-paste && compile:winkeys && compile:linuxkeys && compile:winpaste && compile:linux-paste && compile:linux-system-audio && compile:text-monitor && compile:media-remote && compile:audio-tap` — cada sub-script é no-op nas plataformas onde não se aplica. (`compile:mic-listener` existia para compilar o `macos-mic-listener` de detecção automática de reuniões; removido junto com ela.)

**Dev**: `predev` = `compile:native && download:meeting-aec-helper`. `dev` = `concurrently -k -r "npm:dev:renderer" "npm:dev:main"`. `dev:main` usa `scripts/run-electron.js --dev` (wrapper que remove `ELECTRON_RUN_AS_NODE` e injeta `--ozone-platform=x11` em Wayland+KDE/GNOME).

**Build**: `prebuild`/`prebuild:mac`/`prebuild:win`/`prebuild:linux`/`prepack`/`predist` (hooks automáticos) baixam whisper-cpp, llama-server, sherpa-onnx, meeting-aec-helper, whisper-vad-model, diarization-models — cada variante de plataforma adiciona binários exclusivos (Windows: nircmd, fast-paste, key-listener, system-audio-helper; macOS: `compile:mac-icon`). (Os passos `download:qdrant`/`download:embedding-model` existiam aqui até a remoção do Qdrant — ver `docs/specs/remove-qdrant-dependency.md`. O passo `download:windows-mic-listener` existia aqui até a remoção da detecção automática de reuniões — ver §3.4.)

`build:mac/win/linux` = `build:renderer && electron-builder --<plataforma>`. `pack` = build de diretório não assinado (`CSC_IDENTITY_AUTO_DISCOVERY=false`). `postinstall` = `electron-builder install-app-deps` (recompila módulos nativos, automático pós-`npm install`).

**Qualidade**: `format:check` (eslint+prettier), `lint`, `test` = `node --test "test/helpers/*.test.js" "test/utils/*.test.js"`, `typecheck` (`tsc --noEmit`), `quality-check` = `format:check && typecheck`, `i18n:check`.

### 7.4 Scripts de Download (`scripts/`)

Biblioteca compartilhada `scripts/lib/download-utils.js`: `fetchLatestRelease` (GitHub API, 3 modos: tag exata, latest, prefixo de tag), `downloadFile` (streaming, retry 3x, bearer auth condicional HF/GitHub), `extractZip`/`extractTarGz`, `parseArgs` (`--current`/`--all`/`--platform`/`--arch`/`--force`/`--clean`).

| Script | Fonte | Saída |
|---|---|---|
| `download-whisper-cpp.js` | `OpenWhispr/whisper.cpp` (latest) | `resources/bin/whisper-server-{platform}-{arch}` |
| `download-llama-server.js` | `ggml-org/llama.cpp` (tag fixa `b9763`) | `resources/bin/llama-server-{platform}-{arch}` (só CPU) |
| `download-sherpa-onnx.js` | `k2-fsa/sherpa-onnx` (fixo `1.13.4`) | `sherpa-onnx-{ws,diarize}-{platformArch}` (+`-cuda`) — o binário `online-ws` foi removido junto com os três modelos Parakeet streaming-only (`docs/specs/audio-transcription-batching.md`) |
| `download-whisper-vad-model.js` | HuggingFace `ggml-org/whisper-vad` | `ggml-silero-v5.1.2.bin` |
| `download-diarization-models.js` | `k2-fsa/sherpa-onnx` (tags especiais) | modelos de segmentação/embedding/VAD |
| `download-nircmd.js` | nirsoft.net direto (não GitHub) | `nircmd.exe` (fallback PowerShell sem bypass TLS — usa validação de certificado padrão do SO/.NET) |
| `download-windows-key-listener.js`, `-fast-paste.js`, `-system-audio-helper.js` | `OpenWhispr/openwhispr` (tags `{componente}-v{versão}`) | binários Windows nativos |
| `download-meeting-aec-helper.js` | idem | `meeting-aec-helper-{platform}-{arch}` (4 alvos) |
| `download-text-monitor.js` | idem | linux/windows text monitor |

(`download-qdrant.js` e `download-minilm.js` existiam aqui — baixavam o binário Qdrant e o modelo `all-MiniLM-L6-v2`, respectivamente — e foram removidos junto com o subsistema de busca semântica; ver `docs/specs/remove-qdrant-dependency.md`.)

### 7.5 Scripts de Compilação (`build-*.js`)

**macOS (Swift, via `xcrun swiftc`)**: `build-globe-listener.js`, `build-macos-fast-paste.js`, `build-macos-audio-tap.js` (exige macOS 14.2+, Process Tap), `build-macos-text-monitor.js`, `build-media-remote.js`. Cache incremental via hash SHA-256 do `.swift` fonte + validação do Mach-O header (arquitetura). (`build-macos-mic-listener.js` existia para o `macos-mic-listener` de detecção automática de reuniões; removido junto com ela — ver §3.4.)

**Windows (C, `cl`→MinGW→Clang)**: `build-windows-key-listener.js` (compila primeiro, baixa como fallback), `build-windows-fast-paste.js`/`build-windows-text-monitor.js` (baixa primeiro, compila como fallback). Verificação só por mtime.

**Linux (C, `gcc`→`cc`)**: `build-linux-key-listener.js` (evdev puro, sem libs extras), `build-linux-fast-paste.js` (`-lX11 -lXtst` + defines condicionais `HAVE_UINPUT`/`HAVE_GIO`/`HAVE_ATSPI` via `pkg-config`), `build-linux-system-audio.js` (exige `pkg-config gio-2.0`), `build-linux-text-monitor.js` (baixa primeiro, exige `pkg-config atspi-2`).

**Multiplataforma C++ (o mais complexo)**: `build-meeting-aec-helper.js` + `scripts/lib/meeting-aec-build.js` — compila cancelamento de eco acústico embutindo trechos do WebRTC Audio Processing Module (commit fixo `08f235e...`) + Abseil (commit fixo `9ac7062...`), resolvidos via interpretador Bazel BUILD.bazel embutido em Python (**exige `python3` no PATH da máquina de build**). CMake se disponível, senão `clang`/`gcc` direto (Windows exige CMake).

### 7.6 Empacotamento Electron (`electron-builder.json`)

- `afterPack`: `scripts/afterPack.js`.
- **`asarUnpack`**: `ffmpeg-static`, `ps-list`, `better-sqlite3`, `onnxruntime-node`, `@napi-rs/keyring`, `src/workers/**/*` — binários nativos não podem rodar de dentro do ASAR. `afterPack.js` **falha o build** se algum estiver ausente.
- **`extraResources`**: `.env`, `src/assets/**/*`, todo `resources/bin/**` (whisper/llama/sherpa, binários nativos por plataforma, modelos de diarização/VAD, bibliotecas compartilhadas). O filtro `qdrant-*` (e o modelo `all-MiniLM-L6-v2/**/*`) foi removido junto com o subsistema Qdrant.

#### 7.6.1 `afterPack.js` — 5 responsabilidades
1. `stripOnnxruntimeBinaries` — remove plataformas/arch não-alvo (economiza 150-180MB).
2. `wrapLinuxBinary` — renomeia binário Electron para `{nome}-app`, injeta wrapper (força XWayland em Wayland, decide `--no-sandbox`).
3. `verifyMeetingAecHelper` — não-fatal se ausente (fallback para detector JS).
4. `verifyUnpackedBinaries` — **falha o build** se faltar ffmpeg/onnxWorker.js/(Windows) fastlist.
5. `registerMacResourceBinariesForSigning` — identifica Mach-O binaries em `Contents/Resources` e registra para assinatura individual.

#### 7.6.2 Por plataforma
- **macOS**: `dmg`+`zip`, `hardenedRuntime:true`, entitlements (`allow-unsigned-executable-memory`, `allow-jit`, `disable-library-validation`, `audio-input`), notarização via `@electron/notarize`.
- **Windows**: `nsis`+`portable`, `resources/nsis/installer.nsh` — regra de firewall **BLOCK** de entrada para `sherpa-onnx-ws-win32-x64.exe` (servidor só escuta 127.0.0.1 mas o binário não tem opção loopback-only; loopback nunca é filtrado pelo Firewall, então a transcrição local continua funcionando sem prompt do SO).
- **Linux**: `AppImage`+`deb`+`rpm`+`tar.gz`. `after-install.sh`: SUID root no `chrome-sandbox`, regra udev para `/dev/uinput` (grupo `input`), serviço systemd `ydotoold`. `flatpak` config presente (runtime `org.freedesktop.Platform` 24.08).

### 7.7 Recursos Nativos (`resources/*.c`/`*.swift`)

Padrão comum: stdout = dados/eventos em texto simples; stderr = diagnóstico/JSON (exceto helpers de áudio de sistema, onde stdout = PCM binário cru).

| Plataforma | Arquivo | Propósito |
|---|---|---|
| Windows | `windows-key-listener.c` | Push-to-talk (`WH_KEYBOARD_LL`) |
| Windows | `windows-system-audio-helper.c` | Captura loopback (exclui próprio processo) |
| Windows | `windows-fast-paste.c` | Cola texto (SendInput) |
| Windows | `windows-text-monitor.c` | UI Automation, detecta mudança pós-paste |
| Linux | `linux-key-listener.c` | evdev (funciona X11+Wayland) |
| Linux | `linux-fast-paste.c` | 3 backends: XTest/portal Wayland/uinput |
| Linux | `linux-system-audio-helper.c` | PipeWire loopback |
| Linux | `linux-text-monitor.c`/`.py` | AT-SPI2 (Python usa event listeners, mais eficiente) |
| macOS | `macos-globe-listener.swift` | Fn/Globe, modificadores direitos, botões de mouse |
| macOS | `macos-audio-tap.swift` | Core Audio Process Tap (14.2+) |
| macOS | `macos-fast-paste.swift` | Cmd+V simples |
| macOS | `macos-text-monitor.swift` | Accessibility API |
| macOS | `macos-media-remote.swift` | Framework privada MediaRemote |

(`windows-mic-listener.c`/`macos-mic-listener.swift` existiam para detecção automática de reuniões via atividade de microfone; ambos removidos junto com todo o sistema de detecção — ver §3.4.)

### 7.8 Testes (`test/`)

`npm test` = `node --test` (runner nativo, sem Jest/Mocha). 61 arquivos (51 `test/helpers/` + 10 `test/utils/`), cada um autocontido com mocks via interceptação de `Module._load`. Cobertura: wake word, roteamento de ditado, dicionário/eco, auto-learn (correções + proveniência + guard de anti-oscilação, invariante do baseline final do text-monitor), hotkeys, backends llama, VAD/streaming, GPU mode resolver, snippets, gravação manual de reunião (`manualMeetingLauncher.test.js`), etc.

### 7.9 CI (`.github/workflows/`)

13 workflows: `tests.yml` (PR, `npm ci --ignore-scripts && npm test`), `lockfile-lint.yml`, `codeql.yml` (segunda-feira + push/PR), `build-and-notarize.yml` (push/PR, build Windows assinado via Azure Trusted Signing em push / não-assinado em PR; desde a otimização de CI, a divergência PR-vs-push também é de escopo do target, não só de assinatura — PR compila apenas o target `--dir` (unpacked, sem NSIS/portable), enquanto push/`workflow_dispatch` continua com o build completo `nsis`+`portable` assinado), `release.yml` (tag `v*.*.*`, publica release oficial), `auto-release.yml` (cron diário `0 3 * * *` UTC + `workflow_dispatch` com input `force`; faz bump patch/tag/push somente se houver commits não lançados desde a última tag `v*.*.*`, senão é um no-op), 6 workflows de binário nativo individual (`build-windows-key-listener.yml`, etc. — `workflow_dispatch`, compilam e publicam tag própria `{componente}-v*`), `update-nix.yml` (atualiza `nix/package.nix`). (`build-windows-mic-listener.yml` existia para o binário de detecção automática de reuniões; removido junto com ela — ver §3.4.)

### 7.10 Roteiro de Recriação do Ambiente de Build

1. Node 26 (`.nvmrc`).
2. `npm install` (Windows precisa MSVC/Build Tools para `postinstall` recompilar `better-sqlite3`/`onnxruntime-node`).
3. `.env` na raiz com chaves de provedores de IA a testar.
4. `npm run dev` (dispara `predev` automaticamente).
5. Empacotar: `npm run build:{mac|win|linux}` (dispara `prebuild:{plataforma}` — baixa todos os binários prebuilt de todas as plataformas + compila nativos locais).
6. Teste rápido não assinado: `npm run pack`.
7. Assinatura macOS requer identidade Apple Developer própria; Windows usa Azure Trusted Signing (ou `electron-builder.unsigned-win.json` sem credenciais).
8. `npm test && npm run quality-check` antes de qualquer PR (replica `tests.yml` + lint/tipo do CI).

---

*Fim da especificação. Este documento foi gerado por pesquisa automatizada de 7 agentes independentes sobre o estado do código na branch `chore/remove-dead-cloud-code`. Onde o comportamento divergir do `CLAUDE.md` do projeto, confie neste documento e no código-fonte, não na documentação de referência antiga.*
