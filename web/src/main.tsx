// SPDX-License-Identifier: AGPL-3.0-only
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  MessagePrimitive,
  ComposerPrimitive,
  ActionBarPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { useA2ARuntime, type A2ATask } from "@assistant-ui/react-a2a";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import {
  ArrowUp,
  Check,
  CheckCheck,
  ChevronDown,
  Copy,
  Download,
  FileText,
  LoaderCircle,
  LogOut,
  Menu,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  Square,
  X,
  PanelRight,
  Bot,
} from "lucide-react";
import {
  api,
  historyRepository,
  makeClient,
  profileName,
  TaskClient,
  taskTitle,
  terminal,
  waiting,
  type Profile,
  type Session,
} from "./client";
import "./style.css";

const labels: Record<string, string> = {
  submitted: "Queued",
  working: "Working",
  completed: "Completed",
  failed: "Failed",
  canceled: "Canceled",
  input_required: "Awaiting reply",
  auth_required: "Authentication required",
  rejected: "Rejected",
  unspecified: "Pending",
};
const time = (value?: string) =>
  value
    ? new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(value))
    : "";
function Status({ task }: { task?: A2ATask }) {
  const state = task?.status.state ?? "new";
  return (
    <span className={`status status-${state}`}>
      <span />
      {task?.metadata?.recoveryRequired
        ? "Reconciliation required"
        : (labels[state] ?? "New task")}
    </span>
  );
}
function Brand() {
  return (
    <div className="brand">
      <img src="/ui/agyn.png" alt="Agyn" width="28" height="28" />
      <strong>AIRA</strong>
      <span>A2A</span>
    </div>
  );
}
function App() {
  const [session, setSession] = useState<Session | null>();
  const [loginError, setLoginError] = useState("");
  const loadSession = useCallback(async () => {
    const response = await fetch("/web-api/session", {
      credentials: "same-origin",
    });
    if (response.status === 401) {
      setSession(null);
      return;
    }
    if (!response.ok) throw new Error("Service unavailable.");
    setSession((await response.json()) as Session);
  }, []);
  useEffect(() => {
    void loadSession().catch(() => {
      setSession(null);
      setLoginError("Service unavailable.");
    });
  }, [loadSession]);
  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => {
      void loadSession().catch(() => {});
    }, 30_000);
    return () => clearInterval(timer);
  }, [Boolean(session), loadSession]);
  if (session === undefined)
    return (
      <div className="loading-screen">
        <LoaderCircle className="spin" aria-label="Loading workspace" />
      </div>
    );
  if (session === null)
    return (
      <Login
        error={loginError}
        onLogin={async (token) => {
          await api("login", { token });
          setLoginError("");
          await loadSession();
        }}
      />
    );
  return (
    <Workspace
      session={session}
      onLogout={async () => {
        await api("logout", {});
        setSession(null);
      }}
    />
  );
}
function Login({
  onLogin,
  error,
}: {
  onLogin: (token: string) => Promise<void>;
  error: string;
}) {
  const [token, setToken] = useState("");
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <main className="login">
      <Brand />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setFailure("");
          void onLogin(token)
            .catch((e) => setFailure(e.message))
            .finally(() => {
              setToken("");
              setBusy(false);
            });
        }}
      >
        <Bot size={30} />
        <h1>Agent Workspace</h1>
        <label htmlFor="token">Access token</label>
        <input
          id="token"
          type="password"
          autoComplete="off"
          autoFocus
          value={token}
          onChange={(e) => setToken(e.target.value)}
          required
        />
        {(failure || error) && (
          <p className="error" role="alert">
            {failure || error}
          </p>
        )}
        <button className="primary" disabled={busy || !token.trim()}>
          {busy ? <LoaderCircle className="spin" size={16} /> : null}Sign in
        </button>
        <a
          href="https://github.com/smartphonekey/kind-a2a"
          target="_blank"
          rel="noreferrer"
        >
          Source code
        </a>
      </form>
    </main>
  );
}
type Selection = { key: string; profileId: string; task?: A2ATask };
function Workspace({
  session,
  onLogout,
}: {
  session: Session;
  onLogout: () => Promise<void>;
}) {
  const [tasks, setTasks] = useState<A2ATask[]>([]),
    [nextPage, setNextPage] = useState("");
  const [selection, setSelection] = useState<Selection>({
    key: "new",
    profileId: session.defaultProfile,
  });
  const [filter, setFilter] = useState(""),
    [error, setError] = useState("");
  const [loading, setLoading] = useState(true),
    [mobileMenu, setMobileMenu] = useState(false),
    [details, setDetails] = useState(false);
  const loadingTask = useRef(0);
  const initialLocationLoaded = useRef(false);
  const client = useMemo(() => makeClient(), []);
  const refresh = useCallback(
    async (pageToken = "") => {
      const page = await client.listTasks({
        pageSize: 100,
        historyLength: 1,
        pageToken,
      });
      setTasks((current) =>
        pageToken
          ? [
              ...new Map(
                [...current, ...page.tasks].map((t) => [t.id, t]),
              ).values(),
            ]
          : [
              ...page.tasks,
              ...current.filter((t) => !page.tasks.some((n) => n.id === t.id)),
            ],
      );
      setNextPage(page.nextPageToken);
      setError("");
      setLoading(false);
    },
    [client],
  );
  const selectTask = useCallback(
    async (id: string) => {
      const generation = ++loadingTask.current;
      setError("");
      try {
        const task = await client.getTask(id, 1000);
        if (generation !== loadingTask.current) return;
        const profileId = String(task.metadata?.profileId);
        if (!session.profiles.some((p) => p.id === profileId))
          throw new Error("This task's agent profile is no longer available.");
        setSelection({ key: id, task, profileId });
        setMobileMenu(false);
        history.replaceState(null, "", `#task=${encodeURIComponent(id)}`);
      } catch (e) {
        if (generation === loadingTask.current) setError((e as Error).message);
      }
    },
    [client, session.profiles],
  );
  useEffect(() => {
    void refresh().catch(() => {
      setError("Cannot load tasks.");
      setLoading(false);
    });
    const timer = setInterval(() => {
      void refresh().catch(() =>
        setError("Connection interrupted. Tasks may still be running."),
      );
    }, 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    const navigate = () => {
      const id = new URLSearchParams(location.hash.slice(1)).get("task");
      if (id) void selectTask(id);
      else {
        loadingTask.current++;
        setSelection({
          key: crypto.randomUUID(),
          profileId: session.defaultProfile,
        });
        setMobileMenu(false);
      }
    };
    if (!initialLocationLoaded.current) {
      initialLocationLoaded.current = true;
      navigate();
    }
    window.addEventListener("hashchange", navigate);
    return () => window.removeEventListener("hashchange", navigate);
  }, [selectTask, session.defaultProfile]);
  const newTask = (profileId = selection.profileId) => {
    loadingTask.current++;
    setSelection({ key: crypto.randomUUID(), profileId });
    setMobileMenu(false);
    setError("");
    history.replaceState(null, "", location.pathname);
  };
  const onTask = useCallback((task: A2ATask) => {
    setTasks((current) => [task, ...current.filter((t) => t.id !== task.id)]);
    // Record the server task ID without remounting the active runtime.
    setSelection((current) =>
      current.task?.id === task.id ? current : { ...current, task },
    );
    history.replaceState(null, "", `#task=${encodeURIComponent(task.id)}`);
  }, []);
  const shown = tasks.filter((t) =>
    `${taskTitle(t)} ${t.id} ${t.metadata?.profileId}`
      .toLowerCase()
      .includes(filter.toLowerCase()),
  );
  return (
    <main className="workspace">
      {mobileMenu && (
        <button
          className="scrim"
          aria-label="Close task list"
          onClick={() => setMobileMenu(false)}
        />
      )}
      <aside className={`sidebar ${mobileMenu ? "sidebar-open" : ""}`}>
        <div className="sidebar-top">
          <Brand />
          <button
            className="icon mobile-only"
            title="Close task list"
            aria-label="Close task list"
            onClick={() => setMobileMenu(false)}
          >
            <X size={18} />
          </button>
        </div>
        <button className="new-task" onClick={() => newTask()}>
          <Plus size={17} />
          New task
        </button>
        <label className="search">
          <Search size={15} />
          <input
            aria-label="Search tasks"
            placeholder="Search tasks"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </label>
        <div className="section-label">
          <span>Tasks</span>
          <button
            className="icon"
            title="Refresh tasks"
            aria-label="Refresh tasks"
            onClick={() =>
              void refresh().catch(() => setError("Cannot refresh tasks."))
            }
          >
            <RefreshCw size={14} />
          </button>
        </div>
        <nav className="task-list" aria-label="Tasks">
          {loading && (
            <div className="list-empty">
              <LoaderCircle className="spin" size={16} />
              Loading tasks
            </div>
          )}
          {!loading && !shown.length && (
            <div className="list-empty">
              {filter ? "No matching tasks" : "No tasks yet"}
            </div>
          )}
          {shown.map((task) => (
            <button
              key={task.id}
              className={`task-item ${selection.task?.id === task.id ? "selected" : ""}`}
              aria-current={selection.task?.id === task.id ? "true" : undefined}
              onClick={() => void selectTask(task.id)}
            >
              <span className="task-title">
                <MessageSquare size={14} />
                <span>{taskTitle(task)}</span>
              </span>
              <span className="task-meta">
                <Status task={task} />
                <span>{String(task.metadata?.profileId ?? "")}</span>
              </span>
            </button>
          ))}
          {nextPage && (
            <button
              className="text-button"
              onClick={() =>
                void refresh(nextPage).catch(() =>
                  setError("Cannot load more tasks."),
                )
              }
            >
              Load more
            </button>
          )}
        </nav>
        <div className="sidebar-bottom">
          <span className="identity">
            <span className="avatar">
              {session.subject.slice(0, 1).toUpperCase()}
            </span>
            <span>{session.subject}</span>
          </span>
          <button
            className="icon"
            aria-label="Sign out"
            title="Sign out"
            onClick={() =>
              void onLogout().catch(() => setError("Sign out failed."))
            }
          >
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      <section className="main-panel">
        {error && (
          <div role="alert" className="global-error">
            {error}
          </div>
        )}
        <ChatSession
          key={selection.key}
          selection={selection}
          profiles={session.profiles}
          onNew={newTask}
          onTask={onTask}
          onMenu={() => setMobileMenu(true)}
          details={details}
          onDetails={() => setDetails((v) => !v)}
        />
      </section>
    </main>
  );
}
function ChatSession({
  selection,
  profiles,
  onNew,
  onTask,
  onMenu,
  details,
  onDetails,
}: {
  selection: Selection;
  profiles: Profile[];
  onNew: (profile?: string) => void;
  onTask: (task: A2ATask) => void;
  onMenu: () => void;
  details: boolean;
  onDetails: () => void;
}) {
  const [task, setTask] = useState(selection.task),
    [error, setError] = useState(""),
    [canceling, setCanceling] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const client = useMemo(
    () => new TaskClient(selection.profileId, selection.task),
    [],
  );
  const historyAdapter = useMemo(
    () => ({
      load: async () => historyRepository(selection.task),
      append: async () => {},
    }),
    [],
  );
  const runtime = useA2ARuntime({
    client,
    contextId: selection.task?.contextId,
    adapters: { history: historyAdapter },
    configuration: { acceptedOutputModes: ["text/plain"], historyLength: 0 },
    onError: (e) => {
      setNeedsReload(true);
      setError(`${e.message} No message was retried.`);
    },
  });
  useEffect(() => {
    let closed = false;
    client.onTask = (next) => {
      if (!closed) {
        setTask(next);
        onTask(next);
      }
    };
    const sync = async () => {
      if (!client.task || client.streaming) return;
      try {
        const next = await client.getTask(client.task.id, 1000);
        if (closed || client.streaming) return;
        client.task = next;
        setTask(next);
        onTask(next);
        runtime.thread.import(historyRepository(next));
      } catch {
        if (!closed) {
          setNeedsReload(true);
          setError("Connection interrupted. Task state is unconfirmed.");
        }
      }
    };
    const timer = setInterval(() => {
      void sync();
    }, 2000);
    return () => {
      closed = true;
      clearInterval(timer);
      client.onTask = () => {};
    };
  }, [client, runtime, onTask]);
  const cancel = async () => {
    if (!client.task || canceling) return;
    setCanceling(true);
    setError("");
    try {
      const next = await client.cancelTask(client.task.id);
      client.task = next;
      setTask(next);
      onTask(next);
    } catch {
      setError(
        "Cancellation was not confirmed. Reload the task to check its state.",
      );
    } finally {
      setCanceling(false);
    }
  };
  const blocked =
    needsReload ||
    terminal(task) ||
    Boolean(task?.metadata?.recoveryRequired) ||
    Boolean(task?.metadata?.cancellationRequested);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <header className="chat-header">
        <button
          className="icon mobile-only"
          aria-label="Open task list"
          onClick={onMenu}
        >
          <Menu size={19} />
        </button>
        <div className="agent-select">
          <Bot size={19} />
          <select
            aria-label="Agent"
            value={selection.profileId}
            onChange={(e) => onNew(e.target.value)}
          >
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profileName(profile)}
              </option>
            ))}
          </select>
          <ChevronDown size={14} />
        </div>
        <div className="header-right">
          <Status task={task} />
          <button
            className="icon"
            aria-label="Task details"
            aria-pressed={details}
            title="Task details"
            onClick={onDetails}
          >
            <PanelRight size={18} />
          </button>
        </div>
      </header>
      <div className="chat-body">
        <ThreadPrimitive.Root className="thread">
          <ThreadPrimitive.Viewport className="messages">
            {!task && (
              <div className="empty-thread">
                <img src="/ui/agyn.png" alt="" width="44" height="44" />
                <h1>
                  {profiles.find((p) => p.id === selection.profileId)?.name ??
                    selection.profileId}
                </h1>
                <span>New task</span>
              </div>
            )}
            <ThreadPrimitive.Messages
              components={{ UserMessage, AssistantMessage }}
            />
          </ThreadPrimitive.Viewport>
          <div className="composer-area">
            {error && (
              <div className="error" role="alert">
                {error}
                <button
                  className="icon"
                  aria-label="Reload task"
                  title="Reload task"
                  onClick={() => location.reload()}
                >
                  <RefreshCw size={15} />
                </button>
              </div>
            )}
            {task?.metadata?.recoveryRequired ? (
              <div className="task-notice">
                Operator reconciliation required. Automatic retry is disabled.
              </div>
            ) : null}
            {terminal(task) ? (
              <div className="task-notice">
                <Status task={task} />
                <button className="text-button" onClick={() => onNew()}>
                  <Plus size={15} />
                  New task
                </button>
              </div>
            ) : null}
            <ComposerPrimitive.Root
              className={`composer ${blocked ? "disabled" : ""}`}
            >
              <ComposerPrimitive.Input
                aria-label="Message"
                placeholder={
                  needsReload
                    ? "Connection interrupted"
                    : blocked
                      ? "Task unavailable"
                      : "Message agent..."
                }
                disabled={blocked}
                autoFocus
                rows={2}
                className="composer-input"
              />
              <div className="composer-footer">
                <span className="composer-label">
                  {task?.metadata?.resourcesReleased ? (
                    <>
                      <CheckCheck size={14} />
                      Compute released
                    </>
                  ) : task ? (
                    <>
                      <span className="activity-dot" />
                      {waiting(task)
                        ? "Awaiting reply"
                        : labels[task.status.state]}
                    </>
                  ) : (
                    <>
                      <Bot size={14} />
                      {selection.profileId}
                    </>
                  )}
                </span>
                <div className="composer-actions">
                  {task && !terminal(task) && (
                    <button
                      type="button"
                      className="icon"
                      title="Cancel task"
                      aria-label="Cancel task"
                      disabled={
                        canceling ||
                        Boolean(task.metadata?.cancellationRequested)
                      }
                      onClick={() => void cancel()}
                    >
                      {canceling ? (
                        <LoaderCircle className="spin" size={16} />
                      ) : (
                        <Square size={15} />
                      )}
                    </button>
                  )}
                  <ComposerPrimitive.Send
                    className="send"
                    disabled={blocked}
                    aria-label="Send message"
                    title="Send message"
                  >
                    <ArrowUp size={19} />
                  </ComposerPrimitive.Send>
                </div>
              </div>
            </ComposerPrimitive.Root>
            <div className="bottom-note">
              <span>A2A 1.0</span>
              <span>Trusted local lab</span>
              <a
                href="https://github.com/smartphonekey/kind-a2a"
                target="_blank"
                rel="noreferrer"
              >
                Source
              </a>
            </div>
          </div>
        </ThreadPrimitive.Root>
        {details && <TaskDetails task={task} onClose={onDetails} />}
      </div>
    </AssistantRuntimeProvider>
  );
}
const Markdown = () => (
  <MarkdownTextPrimitive
    className="markdown"
    components={{
      a: (props) => <a {...props} target="_blank" rel="noreferrer noopener" />,
      img: (props) => <span className="image-alt">{props.alt ?? "Image"}</span>,
    }}
  />
);
function UserMessage() {
  return (
    <MessagePrimitive.Root className="message user-message">
      <div className="message-heading">You</div>
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  );
}
function AssistantMessage() {
  const running = useAuiState((s) => s.message.status?.type === "running");
  return (
    <MessagePrimitive.Root className="message assistant-message">
      <div className="message-heading">
        <Bot size={16} />
        Agent{running && <LoaderCircle size={13} className="spin" />}
      </div>
      <MessagePrimitive.Parts components={{ Text: Markdown }} />
      <MessagePrimitive.Error>
        <span className="error">Message interrupted</span>
      </MessagePrimitive.Error>
      <ActionBarPrimitive.Root className="message-actions">
        <ActionBarPrimitive.Copy
          className="icon"
          title="Copy message"
          aria-label="Copy message"
        >
          <Copy size={13} />
        </ActionBarPrimitive.Copy>
      </ActionBarPrimitive.Root>
    </MessagePrimitive.Root>
  );
}
function TaskDetails({
  task,
  onClose,
}: {
  task?: A2ATask;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <aside className="details">
      <div className="details-heading">
        <h2>Task details</h2>
        <button
          className="icon"
          title="Close task details"
          aria-label="Close task details"
          onClick={onClose}
        >
          <X size={17} />
        </button>
      </div>
      <Status task={task} />
      {task ? (
        <>
          <dl>
            <dt>Task ID</dt>
            <dd className="id-value">
              <code>{task.id}</code>
              <button
                className="icon"
                title="Copy task ID"
                aria-label="Copy task ID"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(task.id)
                    .then(() => setCopied(true))
                    .catch(() => {})
                }
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </dd>
            <dt>Agent profile</dt>
            <dd>{String(task.metadata?.profileId ?? "")}</dd>
            <dt>Updated</dt>
            <dd>{time(task.status.timestamp)}</dd>
            <dt>Compute</dt>
            <dd>
              {task.metadata?.resourcesReleased
                ? "Released"
                : terminal(task)
                  ? "Stopped"
                  : "Pending / active"}
            </dd>
            <dt>Context</dt>
            <dd>
              <code>{task.contextId}</code>
            </dd>
          </dl>
          <h3>
            Artifacts <span>{task.artifacts?.length ?? 0}</span>
          </h3>
          {!task.artifacts?.length && <p className="muted">No artifacts</p>}
          {task.artifacts?.map((artifact) => (
            <div className="artifact" key={artifact.artifactId}>
              <FileText size={16} />
              <div>
                <strong>{artifact.name || artifact.artifactId}</strong>
                <span>{artifact.description}</span>
              </div>
              <button
                className="icon"
                title="Download artifact"
                aria-label={`Download ${artifact.name || "artifact"}`}
                onClick={() => {
                  const content = artifact.parts
                    .map(
                      (p) =>
                        p.text ??
                        (p.data
                          ? JSON.stringify(p.data, null, 2)
                          : (p.url ?? "")),
                    )
                    .join("\n");
                  const url = URL.createObjectURL(
                    new Blob([content], { type: "text/plain" }),
                  );
                  const anchor = document.createElement("a");
                  anchor.href = url;
                  anchor.download = (artifact.name || "artifact.txt").replace(
                    /[/\\]/g,
                    "_",
                  );
                  anchor.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                }}
              >
                <Download size={15} />
              </button>
            </div>
          ))}
        </>
      ) : (
        <p className="muted">No task started</p>
      )}
    </aside>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
