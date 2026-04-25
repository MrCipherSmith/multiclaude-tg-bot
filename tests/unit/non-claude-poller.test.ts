import { describe, test, expect, mock } from "bun:test";

describe("non-claude-poller: import contract", () => {
  test("startNonClaudePoller is callable and returns a stop function", async () => {
    const mod = await import("../../scripts/non-claude-poller.ts");
    expect(typeof mod.startNonClaudePoller).toBe("function");

    // We can't easily mock postgres.Sql template tag. Smoke test:
    // verify the function takes (sql, driver) and the first arg type is permissive.
    // Just check signature length.
    expect(mod.startNonClaudePoller.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------- Test doubles ----------

/**
 * Build a fake postgres.js sql tagged-template function.
 *
 * postgres.js sql is invoked as `sql\`SELECT ...\`` and returns a thenable that
 * resolves to rows. Our fake records every invocation and returns canned rows
 * matched by substring against the joined template string.
 *
 * The poller's actual usage of `sql` is narrow (one SELECT, one UPDATE), so we
 * can cheat: just match on a unique substring per query and return rows.
 */
function makeFakeSql(responses: Map<string, unknown[]>) {
  const calls: Array<{ query: string; values: unknown[] }> = [];
  function fake(template: TemplateStringsArray, ...values: unknown[]) {
    const query = template.join("?");
    calls.push({ query, values });
    let result: unknown[] = [];
    for (const [pattern, rows] of responses) {
      if (query.includes(pattern)) {
        result = rows;
        break;
      }
    }
    // Return a Promise with `.catch` (the poller uses `.catch(() => {})` on UPDATEs).
    return Promise.resolve(result);
  }
  return Object.assign(fake, { calls });
}

/**
 * Build a mock RuntimeDriver. All five methods are bun mocks so callers can
 * inspect call arguments via `.mock.calls`. Pass overrides to replace any
 * specific method (e.g. `sendInput` that throws).
 */
function makeMockDriver(overrides: Record<string, unknown> = {}) {
  return {
    name: "tmux",
    start: mock(async () => ({ driver: "tmux" as const })),
    stop: mock(async () => {}),
    sendInput: mock(async () => {}),
    health: mock(async () => ({
      state: "running" as const,
      lastChecked: new Date(),
    })),
    snapshot: mock(async () => ({
      lines: [] as string[],
      capturedAt: new Date(),
      handle: { driver: "tmux" as const },
    })),
    ...overrides,
  };
}

// ---------- Behavioral tests ----------
//
// The poller runs on a 1500ms setInterval, so each behavioral test has to wait
// at least that long for a single tick. We use 1700ms (1500ms interval +
// 200ms buffer) which is sufficient on a quiet machine. This is acknowledged
// slowness — the alternative would be extracting `tick` for direct invocation,
// which would require a refactor of the production code.

describe("non-claude-poller: behavior", () => {
  test("returns a stop function that can be called without error", async () => {
    const sqlFake = makeFakeSql(new Map());
    const driver = makeMockDriver();
    const { startNonClaudePoller } = await import(
      "../../scripts/non-claude-poller.ts"
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stop = startNonClaudePoller(sqlFake as any, driver);
    expect(typeof stop).toBe("function");
    stop();
  });

  test("delivers a queued message via driver.sendInput and marks delivered", async () => {
    const fixedNow = new Date();
    const responses = new Map<string, unknown[]>([
      [
        "FROM message_queue mq",
        [
          {
            id: 1,
            session_id: 100,
            content: "hello world",
            created_at: fixedNow,
            cli_type: "codex-cli",
            metadata: null,
            tmux_window: "myproj",
          },
        ],
      ],
    ]);
    const sqlFake = makeFakeSql(responses);
    const driver = makeMockDriver();
    const { startNonClaudePoller } = await import(
      "../../scripts/non-claude-poller.ts"
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stop = startNonClaudePoller(sqlFake as any, driver);

    // Wait for one poll tick (1500ms + buffer).
    await new Promise((r) => setTimeout(r, 1700));
    stop();

    expect(driver.sendInput).toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sendCalls = (driver.sendInput as any).mock.calls as unknown[][];
    const lastCall = sendCalls[sendCalls.length - 1];
    expect(lastCall[0]).toMatchObject({ tmuxWindow: "myproj" });
    expect(lastCall[1]).toMatchObject({ kind: "text", text: "hello world" });

    // Verify a `delivered = true` UPDATE was issued.
    const updateCalls = sqlFake.calls.filter(
      (c) =>
        c.query.includes("UPDATE message_queue") &&
        c.query.includes("delivered = true"),
    );
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("drops stale messages older than 5 min and marks them delivered without sending", async () => {
    const oldDate = new Date(Date.now() - 6 * 60 * 1000); // 6 minutes ago
    const responses = new Map<string, unknown[]>([
      [
        "FROM message_queue mq",
        [
          {
            id: 99,
            session_id: 100,
            content: "ancient",
            created_at: oldDate,
            cli_type: "codex-cli",
            metadata: null,
            tmux_window: "myproj",
          },
        ],
      ],
    ]);
    const sqlFake = makeFakeSql(responses);
    const driver = makeMockDriver();
    const { startNonClaudePoller } = await import(
      "../../scripts/non-claude-poller.ts"
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stop = startNonClaudePoller(sqlFake as any, driver);

    await new Promise((r) => setTimeout(r, 1700));
    stop();

    // Stale message must not be sent to the runtime.
    expect(driver.sendInput).not.toHaveBeenCalled();
    // But it should be marked delivered to break the retry loop.
    const updateCalls = sqlFake.calls.filter(
      (c) =>
        c.query.includes("UPDATE message_queue") &&
        c.query.includes("delivered = true"),
    );
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("breaks per-session loop on driver.sendInput error to preserve order", async () => {
    const fixedNow = new Date();
    let callCount = 0;
    const responses = new Map<string, unknown[]>([
      [
        "FROM message_queue mq",
        [
          {
            id: 1,
            session_id: 100,
            content: "first",
            created_at: fixedNow,
            cli_type: "codex-cli",
            metadata: null,
            tmux_window: "p",
          },
          {
            id: 2,
            session_id: 100,
            content: "second",
            created_at: fixedNow,
            cli_type: "codex-cli",
            metadata: null,
            tmux_window: "p",
          },
        ],
      ],
    ]);
    const sqlFake = makeFakeSql(responses);
    const driver = makeMockDriver({
      sendInput: mock(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error("simulated tmux error");
        }
      }),
    });
    const { startNonClaudePoller } = await import(
      "../../scripts/non-claude-poller.ts"
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stop = startNonClaudePoller(sqlFake as any, driver);
    await new Promise((r) => setTimeout(r, 1700));
    stop();

    // First message attempted; second NOT attempted because the loop breaks
    // on error to preserve in-order delivery.
    expect(callCount).toBe(1);
  });

  test("marks delivered when tmux_window is missing to avoid infinite retry", async () => {
    const fixedNow = new Date();
    const responses = new Map<string, unknown[]>([
      [
        "FROM message_queue mq",
        [
          {
            id: 5,
            session_id: 100,
            content: "orphan msg",
            created_at: fixedNow,
            cli_type: "codex-cli",
            metadata: null,
            tmux_window: null, // no resolvable target
          },
        ],
      ],
    ]);
    const sqlFake = makeFakeSql(responses);
    const driver = makeMockDriver();
    const { startNonClaudePoller } = await import(
      "../../scripts/non-claude-poller.ts"
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stop = startNonClaudePoller(sqlFake as any, driver);
    await new Promise((r) => setTimeout(r, 1700));
    stop();

    // No delivery attempt — there's nowhere to send.
    expect(driver.sendInput).not.toHaveBeenCalled();
    // But the message is marked delivered so it doesn't loop forever.
    const updateCalls = sqlFake.calls.filter(
      (c) =>
        c.query.includes("UPDATE message_queue") &&
        c.query.includes("delivered = true"),
    );
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("falls back to metadata.tmux_window when projects join returns null", async () => {
    const fixedNow = new Date();
    const responses = new Map<string, unknown[]>([
      [
        "FROM message_queue mq",
        [
          {
            id: 7,
            session_id: 100,
            content: "via metadata",
            created_at: fixedNow,
            cli_type: "codex-cli",
            metadata: { tmux_window: "fallback-win" },
            tmux_window: null, // join returned null — should pick up metadata
          },
        ],
      ],
    ]);
    const sqlFake = makeFakeSql(responses);
    const driver = makeMockDriver();
    const { startNonClaudePoller } = await import(
      "../../scripts/non-claude-poller.ts"
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stop = startNonClaudePoller(sqlFake as any, driver);
    await new Promise((r) => setTimeout(r, 1700));
    stop();

    expect(driver.sendInput).toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sendCalls = (driver.sendInput as any).mock.calls as unknown[][];
    const lastCall = sendCalls[sendCalls.length - 1];
    expect(lastCall[0]).toMatchObject({ tmuxWindow: "fallback-win" });
  });
});
