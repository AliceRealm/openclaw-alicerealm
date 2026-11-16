import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Shared variable so the os mock factory always returns the test-controlled homeDir
let __testHomeDir: string | undefined;

jest.mock('os', () => {
  const actual = jest.requireActual('os') as typeof import('os');
  return {
    ...actual,
    homedir: jest.fn(() => __testHomeDir ?? actual.homedir()),
  };
});

// Mock definePluginEntry from the SDK — the actual module is ESM-only and
// cannot be loaded by Jest's CJS transform pipeline.
jest.mock('openclaw/plugin-sdk/plugin-entry', () => ({
  definePluginEntry: (opts: any) => opts,
  buildJsonPluginConfigSchema: (schema: any) => schema,
}));

const sendAuthReminderMock = jest.fn();
jest.mock('./auth-reminder-transport', () => ({
  sendAuthReminder: (...args: any[]) => sendAuthReminderMock(...args),
}));

// Mock discoverServers and resolveAliceRealmHome from config
const discoverServersMock = jest.fn();
const resolveAliceRealmHomeMock = jest.fn();

jest.mock('./config', () => {
  const actual = jest.requireActual('./config');
  return {
    ...actual,
    discoverServers: (...args: any[]) => discoverServersMock(...args),
    resolveAliceRealmHome: () => resolveAliceRealmHomeMock(),
  };
});

// Mock execAliceRealm from cli-executor
const execAliceRealmMock = jest.fn();
jest.mock('./cli-executor', () => ({
  execAliceRealm: (...args: any[]) => execAliceRealmMock(...args),
}));

// Mock session-route-memory to intercept store reads/writes
const readStoredNotificationRouteMock = jest.fn();
const writeStoredNotificationRouteMock = jest.fn();
jest.mock('./session-route-memory', () => {
  const actual = jest.requireActual('./session-route-memory');
  return {
    ...actual,
    readStoredNotificationRoute: (...args: any[]) => readStoredNotificationRouteMock(...args),
    writeStoredNotificationRoute: (...args: any[]) => writeStoredNotificationRouteMock(...args),
  };
});

// Mock AliceRealmStreamClient
const streamClientStartMock = jest.fn().mockResolvedValue(undefined);
const streamClientStopMock = jest.fn().mockResolvedValue(undefined);
const streamClientIsRunningMock = jest.fn().mockReturnValue(false);
const streamClientGetLastCursorMock = jest.fn().mockReturnValue(null);

jest.mock('./stream-client', () => ({
  AliceRealmStreamClient: jest.fn().mockImplementation(() => ({
    start: streamClientStartMock,
    adoptCLIVersion: jest.fn().mockResolvedValue(undefined),
    stop: streamClientStopMock,
    isRunning: streamClientIsRunningMock,
    getLastCursor: streamClientGetLastCursorMock,
  })),
}));

// Mock AliceRealmPollingClient with inline feed polling behavior
let capturedPollOnFeedPolled: ((payload: any) => Promise<void>) | null = null;
let capturedPollOnAuthRequired: ((event: any) => Promise<void>) | null = null;
let capturedPollingConfig: any = null;
const pollingClientStartMock = jest.fn().mockResolvedValue(undefined);
const pollingClientStopMock = jest.fn();
const pollingClientPollOnceMock = jest.fn();

jest.mock('./polling-client', () => ({
  AliceRealmPollingClient: jest.fn().mockImplementation((config: any) => {
    capturedPollOnFeedPolled = config.onFeedPolled;
    capturedPollOnAuthRequired = config.onAuthRequired;
    capturedPollingConfig = config;
    return {
      start: pollingClientStartMock,
      stop: pollingClientStopMock,
      pollOnce: pollingClientPollOnceMock,
    };
  }),
}));

function createLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

describe('register unit', () => {
  let homeDir: string;
  let alicerealmHome: string;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    sendAuthReminderMock.mockReset().mockImplementation(async params => ({
      runId: params.idempotencyKey, status: 'ok', result: { deliverySucceeded: true },
    }));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alicerealm-openclaw-home-'));
    alicerealmHome = path.join(homeDir, '.alicerealm');
    fs.mkdirSync(alicerealmHome, { recursive: true });
    __testHomeDir = homeDir;
    resolveAliceRealmHomeMock.mockReturnValue(alicerealmHome);

    // Reset captured callbacks
    capturedPollOnFeedPolled = null;
    capturedPollOnAuthRequired = null;
    capturedPollingConfig = null;

    // Reset session-route-memory mocks
    readStoredNotificationRouteMock.mockReset().mockResolvedValue(undefined);
    writeStoredNotificationRouteMock.mockReset().mockResolvedValue(true);

    // Default alicerealm CLI response so session-route-memory reads succeed (unset key).
    execAliceRealmMock.mockResolvedValue({ kind: 'success', data: undefined });

    // These tests assert the legacy one-shot feed path; opt into it explicitly.
    // The new default (main-session 2a) is covered by its own test below.
    process.env.ALICEREALM_FEED_DELIVERY = 'oneshot';
  });

  afterEach(() => {
    __testHomeDir = undefined;
    delete process.env.ALICEREALM_FEED_DELIVERY;
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  test('registration uses SDK product version and an independent plugin version', async () => {
    const keys = ['ALICEREALM_HOST', 'ALICEREALM_HOST_OVERRIDE', 'ALICEREALM_MODE', 'ALICEREALM_PLUGIN_VERSION'];
    const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    try {
      process.env.ALICEREALM_HOST = 'openclaw/old-plugin';
      process.env.ALICEREALM_HOST_OVERRIDE = '';
      process.env.ALICEREALM_MODE = 'skill';
      const { default: plugin } = await import('./index');
      plugin.register({
        registrationMode: 'full', config: {}, pluginConfig: {},
        runtime: { version: '2026.7.1-2' }, version: '0.0.42',
        logger: createLogger(), registerService: jest.fn(), registerCommand: jest.fn(),
        registerHook: jest.fn(), on: jest.fn(),
      } as any);
      expect(process.env.ALICEREALM_HOST).toBe('openclaw/2026.7.1-2');
      expect(process.env.ALICEREALM_MODE).toBe('plugin');
      expect(process.env.ALICEREALM_PLUGIN_VERSION).toBe(require('../package.json').version);
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
      }
    }
  });

  test('sends auth prompt through the final-result transport when service starts without token', async () => {
    const serverDir = path.join(alicerealmHome, 'servers', 'alicerealm');
    fs.mkdirSync(serverDir, { recursive: true });
    // No credentials.json, so auth is required

    discoverServersMock.mockResolvedValue({ kind: 'ok', servers: [
      { name: 'alicerealm', endpoint: 'http://127.0.0.1:18080', current: true },
    ] });

    // When the polling client starts, it will call pollOnce, which triggers onAuthRequired
    pollingClientStartMock.mockImplementation(async () => {
      if (capturedPollOnAuthRequired) {
        await capturedPollOnAuthRequired({ reason: 'auth_required' });
      }
    });

    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const subagentRun = jest.fn().mockResolvedValue({ runId: 'run-auth' });

    plugin.register({
      registrationMode: 'full',
      config: {},
      pluginConfig: {},
      runtime: {
        subagent: { run: subagentRun, waitForRun: jest.fn().mockResolvedValue({ status: 'ok' }) },
      },
      logger: createLogger(),
      registerService: (service: any) => services.push(service),
      registerCommand: jest.fn(),
      registerHook: jest.fn(),
      on: jest.fn(),
    } as any);

    // There should be a single discovery service
    expect(services).toHaveLength(1);
    expect(services[0].id).toBe('alicerealm:discovery');

    await services[0].start();

    expect(subagentRun).not.toHaveBeenCalled();
    expect(sendAuthReminderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: 'main',
        message: expect.stringContaining('[ALICEREALM_AUTH_REQUIRED]'),
        deliver: true,
      }), 480_000
    );
    const promptMessage = String(sendAuthReminderMock.mock.calls[0]?.[0]?.message);
    expect(promptMessage).toContain('server=alicerealm');
    expect(promptMessage).toContain(`homedir=${alicerealmHome}`);
    expect(promptMessage).toContain('first connection, load the installed ar-onboarding Skill');
    expect(promptMessage).toContain('existing account, load the installed ar-profile Skill');
    expect(promptMessage).not.toContain('auth login');

    await services[0].stop();
  });

  test('heartbeat plan and Feed authentication failures share a retryable owner notification route', async () => {
    const authNotice = JSON.stringify({
      schema_version: 'eigenflux_auth_required.v1', code: 'REFRESH_INVALID',
      owner_action: 'Reply "Recover my current AliceRealm account" to authorize foreground recovery.',
    });
    discoverServersMock.mockResolvedValue({ kind: 'ok', servers: [
      { name: 'alpha', endpoint: 'http://127.0.0.1:18080', current: true },
    ] });
    pollingClientStartMock.mockResolvedValue(undefined);
    execAliceRealmMock.mockImplementation(async (_bin: string, args: string[]) => {
      if (args.includes('heartbeat')) return { kind: 'auth_required', stderr: authNotice };
      return { kind: 'success', data: undefined };
    });
    const { AliceRealmNotifier } = await import('./notifier');
    const deliver = jest.spyOn(AliceRealmNotifier.prototype, 'deliver')
      .mockResolvedValueOnce(false).mockResolvedValue(true);
    const { default: plugin } = await import('./index');
    const services: any[] = [];
    plugin.register({
      registrationMode: 'full', config: {}, pluginConfig: {}, runtime: {}, logger: createLogger(),
      registerService: (service: any) => services.push(service), registerCommand: jest.fn(),
      registerHook: jest.fn(), on: jest.fn(),
    } as any);
    try {
      await services[0].start();
      const actual = jest.requireActual('./polling-client') as typeof import('./polling-client');
      const poller = new actual.AliceRealmPollingClient(capturedPollingConfig);
      execAliceRealmMock.mockClear();
      await expect(poller.pollOnce()).resolves.toMatchObject({ kind: 'auth_required' });
      // One plan command handles authentication; do not issue another Feed command.
      expect(execAliceRealmMock).toHaveBeenCalledTimes(1);
      expect(execAliceRealmMock.mock.calls[0][1]).toEqual([
        '--homedir', alicerealmHome, '--server', 'alpha', 'heartbeat', 'plan', '--format', 'json',
      ]);
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(deliver).toHaveBeenLastCalledWith(expect.any(String), { requireCompletion: true });
      // Failed delivery must not suppress the next source's attempt.
      await capturedPollOnAuthRequired!({ reason: 'auth_required' });
      expect(deliver).toHaveBeenCalledTimes(2);
      // Once delivered, plan and Feed share the same short cooldown.
      await poller.pollOnce();
      expect(deliver).toHaveBeenCalledTimes(2);
      await capturedPollingConfig.onPollSuccess({
        code: 0, msg: 'ok', data: { items: [], notifications: [], has_more: false },
      });
      await capturedPollOnAuthRequired!({ reason: 'auth_required' });
      expect(deliver).toHaveBeenCalledTimes(3);
      const prompt = String(deliver.mock.calls[0][0]);
      expect(prompt).toContain('server=alpha');
      expect(prompt).toContain(`homedir=${alicerealmHome}`);
      expect(prompt).toContain('Deliver a visible warning to the owner');
      expect(prompt).toContain(authNotice);
      expect(prompt).toContain('Write in the owner\'s language');
      expect(prompt).not.toContain('agent provision');
    } finally {
      await services[0].stop();
      deliver.mockRestore();
    }
  });

  test('all unavailable plans stop Feed before creating exposures', async () => {
    discoverServersMock.mockResolvedValue({ kind: 'ok', servers: [
      { name: 'alpha', endpoint: 'http://127.0.0.1:18080', current: true },
    ] });
    pollingClientStartMock.mockResolvedValue(undefined);
    let planError: any = { kind: 'error', error: new Error('AGENT_AUTH_UNAVAILABLE'),
      exitCode: 2, stderr: 'AGENT_AUTH_UNAVAILABLE', authenticationUnavailable: true };
    execAliceRealmMock.mockImplementation(async (_bin: string, args: string[]) => {
      if (args.includes('heartbeat')) return planError;
      if (args.includes('poll')) {
        return { kind: 'success', data: { items: [], notifications: [], has_more: false } };
      }
      return { kind: 'success', data: undefined };
    });
    const { AliceRealmNotifier } = await import('./notifier');
    const deliver = jest.spyOn(AliceRealmNotifier.prototype, 'deliver').mockResolvedValue(true);
    const { default: plugin } = await import('./index');
    const services: any[] = [];
    plugin.register({
      registrationMode: 'full', config: {}, pluginConfig: {}, runtime: {}, logger: createLogger(),
      registerService: (service: any) => services.push(service), registerCommand: jest.fn(),
      registerHook: jest.fn(), on: jest.fn(),
    } as any);
    try {
      await services[0].start();
      const actual = jest.requireActual('./polling-client') as typeof import('./polling-client');
      const poller = new actual.AliceRealmPollingClient({
        ...capturedPollingConfig,
        onPollSuccess: jest.fn(),
      });
      for (const code of ['AGENT_AUTH_UNAVAILABLE', 'AUTH_NETWORK_UNAVAILABLE']) {
        planError = { kind: 'error', error: new Error(code), exitCode: 2, stderr: code,
          authenticationUnavailable: true };
        execAliceRealmMock.mockClear();
        await expect(poller.pollOnce()).resolves.toEqual({ kind: 'error', error: planError.error });
        expect(execAliceRealmMock).toHaveBeenCalledTimes(1);
        expect(execAliceRealmMock.mock.calls[0][1]).toEqual([
          '--homedir', alicerealmHome, '--server', 'alpha', 'heartbeat', 'plan', '--format', 'json',
        ]);
        expect(deliver).not.toHaveBeenCalled();
      }
      // A previous credential failure must not poison later ordinary failures.
      for (const message of ['HTTP 503 unavailable', 'settings PUT failed: HTTP 503']) {
        planError = { kind: 'error', error: new Error(message), exitCode: 2, stderr: message };
        execAliceRealmMock.mockClear();
        await expect(poller.pollOnce()).resolves.toMatchObject({ kind: 'skipped', reason: 'plan_unavailable' });
        expect(execAliceRealmMock.mock.calls.some(call => call[1].includes('poll'))).toBe(false);
        expect(deliver).not.toHaveBeenCalled();
      }
    } finally {
      await services[0].stop();
      deliver.mockRestore();
    }
  });

  test('plan auth notices retry a failed channel send and cool down only after final delivery', async () => {
    discoverServersMock.mockResolvedValue({ kind: 'ok', servers: [
      { name: 'alpha', endpoint: 'http://127.0.0.1:18080', current: true },
    ] });
    pollingClientStartMock.mockResolvedValue(undefined);
    const notice = JSON.stringify({ schema_version: 'eigenflux_auth_required.v1',
      code: 'REFRESH_INVALID', owner_action: 'Recover my current AliceRealm account' });
    execAliceRealmMock.mockImplementation(async (_bin: string, args: string[]) =>
      args.includes('heartbeat') ? { kind: 'auth_required', stderr: notice } : { kind: 'success', data: undefined });
    sendAuthReminderMock.mockImplementationOnce(async params => ({
      runId: params.idempotencyKey, status: 'ok', result: { deliverySucceeded: false },
    }));
    const subagentRun = jest.fn();
    const lifecycleWait = jest.fn().mockResolvedValue({ status: 'ok' });
    const { default: plugin } = await import('./index');
    const services: any[] = [];
    plugin.register({
      registrationMode: 'full', config: {}, pluginConfig: {},
      runtime: { subagent: { run: subagentRun, waitForRun: lifecycleWait } }, logger: createLogger(),
      registerService: (service: any) => services.push(service), registerCommand: jest.fn(),
      registerHook: jest.fn(), on: jest.fn(),
    } as any);
    try {
      await services[0].start();
      const actual = jest.requireActual('./polling-client') as typeof import('./polling-client');
      const poller = new actual.AliceRealmPollingClient(capturedPollingConfig);
      execAliceRealmMock.mockClear();
      for (let cycle = 0; cycle < 3; cycle++) {
        await expect(poller.pollOnce()).resolves.toMatchObject({ kind: 'auth_required' });
      }
      expect(execAliceRealmMock).toHaveBeenCalledTimes(3);
      expect(execAliceRealmMock.mock.calls.every(([, args]) => args.includes('heartbeat'))).toBe(true);
      expect(sendAuthReminderMock).toHaveBeenCalledTimes(2);
      expect(sendAuthReminderMock.mock.calls[0][0].message).toContain(notice);
      expect(sendAuthReminderMock.mock.calls[1][0].idempotencyKey)
        .not.toBe(sendAuthReminderMock.mock.calls[0][0].idempotencyKey);
      expect(subagentRun).not.toHaveBeenCalled();
      expect(lifecycleWait).not.toHaveBeenCalled();
    } finally {
      await services[0].stop();
    }
  });

  test('supports /alicerealm auth command with discovered servers', async () => {
    const serverDir = path.join(alicerealmHome, 'servers', 'alicerealm');
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(
      path.join(serverDir, 'credentials.json'),
      JSON.stringify({ access_token: 'at_command_token' }),
      'utf-8'
    );

    discoverServersMock.mockResolvedValue({ kind: 'ok', servers: [
      { name: 'alicerealm', endpoint: 'http://127.0.0.1:18080', current: true },
    ] });

    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const commands: any[] = [];

    plugin.register({
      registrationMode: 'full',
      config: {},
      pluginConfig: {},
      runtime: {},
      logger: createLogger(),
      registerService: (service: any) => services.push(service),
      registerCommand: (command: any) => commands.push(command),
      registerHook: jest.fn(),
      on: jest.fn(),
    } as any);

    // Start the discovery service to populate runtimes
    await services[0].start();

    expect(commands).toHaveLength(1);
    const command = commands[0];

    const authResp = await command.handler({ args: 'auth' });
    expect(authResp.text).toContain('AliceRealm auth status (server=alicerealm):');
    expect(authResp.text).toContain('status: available');
    expect(authResp.text).toContain('at_com');

    await services[0].stop();
  });

  test('supports /alicerealm profile command via CLI', async () => {
    const serverDir = path.join(alicerealmHome, 'servers', 'alicerealm');
    fs.mkdirSync(serverDir, { recursive: true });

    discoverServersMock.mockResolvedValue({ kind: 'ok', servers: [
      { name: 'alicerealm', endpoint: 'http://127.0.0.1:18080', current: true },
    ] });

    execAliceRealmMock.mockResolvedValue({
      kind: 'success',
      data: {
        code: 0,
        msg: 'success',
        data: {
          agent: { id: '1', name: 'bot' },
          profile: { status: 3, keywords: ['ai'] },
          influence: { total_items: 1 },
        },
      },
    });

    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const commands: any[] = [];

    plugin.register({
      registrationMode: 'full',
      config: {},
      pluginConfig: {},
      runtime: {},
      logger: createLogger(),
      registerService: (service: any) => services.push(service),
      registerCommand: (command: any) => commands.push(command),
      registerHook: jest.fn(),
      on: jest.fn(),
    } as any);

    await services[0].start();

    const profileResp = await commands[0].handler({ args: 'profile' });
    expect(profileResp.text).toContain('AliceRealm profile (server=alicerealm):');
    expect(profileResp.text).toContain('"name": "bot"');

    await services[0].stop();
  });

  test('supports /alicerealm feed command via polling client', async () => {
    const serverDir = path.join(alicerealmHome, 'servers', 'alicerealm');
    fs.mkdirSync(serverDir, { recursive: true });

    discoverServersMock.mockResolvedValue({ kind: 'ok', servers: [
      { name: 'alicerealm', endpoint: 'http://127.0.0.1:18080', current: true },
    ] });

    pollingClientPollOnceMock.mockResolvedValue({
      kind: 'success',
      payload: {
        code: 0,
        msg: 'success',
        data: {
          items: [
            {
              item_id: '901',
              broadcast_type: 'info',
              updated_at: 1760000000000,
            },
          ],
          has_more: false,
          notifications: [],
        },
      },
    });

    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const commands: any[] = [];

    plugin.register({
      registrationMode: 'full',
      config: {},
      pluginConfig: {},
      runtime: {},
      logger: createLogger(),
      registerService: (service: any) => services.push(service),
      registerCommand: (command: any) => commands.push(command),
      registerHook: jest.fn(),
      on: jest.fn(),
    } as any);

    await services[0].start();

    const feedResp = await commands[0].handler({ args: 'feed' });
    expect(feedResp.text).toContain('AliceRealm feed result (server=alicerealm):');
    expect(feedResp.text).toContain('"item_id": "901"');

    await services[0].stop();
  });

  test('supports /alicerealm here and persists the current conversation route', async () => {
    const serverDir = path.join(alicerealmHome, 'servers', 'alicerealm');
    fs.mkdirSync(serverDir, { recursive: true });

    discoverServersMock.mockResolvedValue({ kind: 'ok', servers: [
      { name: 'alicerealm', endpoint: 'http://127.0.0.1:18080', current: true },
    ] });

    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const commands: any[] = [];
    plugin.register({
      registrationMode: 'full',
      config: {},
      pluginConfig: {
        serverRouting: {
          alicerealm: {
            sessionKey: 'agent:mengtian:feishu:direct:ou_current',
            agentId: 'mengtian',
            replyChannel: 'feishu',
            replyTo: 'user:ou_current',
            replyAccountId: 'default',
          },
        },
      },
      runtime: {},
      logger: createLogger(),
      registerService: (service: any) => services.push(service),
      registerCommand: (command: any) => commands.push(command),
      registerHook: jest.fn(),
      on: jest.fn(),
    } as any);

    await services[0].start();

    const hereResp = await commands[0].handler({
      args: 'here',
      channel: 'feishu',
      to: 'user:ou_current',
      accountId: 'default',
      getCurrentConversationBinding: jest.fn().mockResolvedValue({
        channel: 'feishu',
        accountId: 'default',
        conversationId: 'user:ou_current',
      }),
    });

    expect(hereResp.text).toContain(
      'AliceRealm server alicerealm will deliver to this conversation by default:'
    );
    expect(hereResp.text).toContain('sessionKey: agent:mengtian:feishu:direct:ou_current');

    // Persistence now happens via the runtime store (writeStoredNotificationRoute)
    expect(writeStoredNotificationRouteMock).toHaveBeenCalled();
    const [, serverName, route] = writeStoredNotificationRouteMock.mock.calls.find(
      ([, server]: any[]) => server === 'alicerealm'
    )!;
    expect(serverName).toBe('alicerealm');
    expect(route).toMatchObject({
      sessionKey: 'agent:mengtian:feishu:direct:ou_current',
      agentId: 'mengtian',
      replyChannel: 'feishu',
      replyTo: 'user:ou_current',
      replyAccountId: 'default',
    });

    await services[0].stop();
  });

  test('succeeds for a legacy agent:<id>:main DM route', async () => {
    const serverDir = path.join(alicerealmHome, 'servers', 'alicerealm');
    fs.mkdirSync(serverDir, { recursive: true });

    // The harness mocks os.homedir() to homeDir (see the jest.mock at the top
    // of this file), so listSessionStorePaths will scan homeDir/.openclaw/agents/*.
    const sessionsRoot = path.join(homeDir, '.openclaw', 'agents', 'main', 'sessions');
    fs.mkdirSync(sessionsRoot, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsRoot, 'sessions.json'),
      JSON.stringify({
        'agent:main:main': {
          updatedAt: Date.now(),
          chatType: 'direct',
          deliveryContext: {
            channel: 'feishu',
            to: 'user:ou_legacy',
            accountId: 'default',
          },
          origin: { provider: 'feishu', chatType: 'direct', to: 'user:ou_legacy' },
          lastTo: 'user:ou_legacy',
        },
      }),
      'utf-8'
    );

    discoverServersMock.mockResolvedValue({
      kind: 'ok',
      servers: [{ name: 'alicerealm', endpoint: 'http://127.0.0.1:18080', current: true }],
    });

    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const commands: any[] = [];
    plugin.register({
      registrationMode: 'full',
      config: {},
      pluginConfig: {
        serverRouting: {
          alicerealm: { agentId: 'main' },
        },
      },
      runtime: {},
      logger: createLogger(),
      registerService: (service: any) => services.push(service),
      registerCommand: (command: any) => commands.push(command),
      registerHook: jest.fn(),
      on: jest.fn(),
    } as any);

    await services[0].start();

    const hereResp = await commands[0].handler({
      args: 'here',
      channel: 'feishu',
      to: 'user:ou_legacy',
      accountId: 'default',
      getCurrentConversationBinding: jest.fn().mockResolvedValue({
        channel: 'feishu',
        accountId: 'default',
        conversationId: 'user:ou_legacy',
      }),
    });

    expect(hereResp.text).not.toContain('Unable to resolve');
    expect(hereResp.text).toContain('sessionKey: agent:main:main');
    expect(hereResp.text).toContain('target: user:ou_legacy');
    await services[0].stop();
  });

  test('prefers runtime.subagent delivery when available', async () => {
    const serverDir = path.join(alicerealmHome, 'servers', 'alicerealm');
    fs.mkdirSync(serverDir, { recursive: true });

    discoverServersMock.mockResolvedValue({ kind: 'ok', servers: [
      { name: 'alicerealm', endpoint: 'http://127.0.0.1:18080', current: true },
    ] });

    pollingClientStartMock.mockImplementation(async () => {
      if (capturedPollOnAuthRequired) {
        await capturedPollOnAuthRequired({ reason: 'auth_required' });
      }
    });

    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const subagentRun = jest.fn().mockResolvedValue({ runId: 'run-subagent' });

    plugin.register({
      registrationMode: 'full',
      config: {},
      pluginConfig: {},
      runtime: {
        subagent: {
          run: subagentRun,
          waitForRun: jest.fn().mockResolvedValue({ status: 'ok' }),
        },
      },
      logger: createLogger(),
      registerService: (service: any) => services.push(service),
      registerCommand: jest.fn(),
    } as any);

    await services[0].start();

    expect(subagentRun).not.toHaveBeenCalled();
    expect(sendAuthReminderMock).toHaveBeenCalledWith({
      sessionKey: 'main',
      message: expect.stringContaining('[ALICEREALM_AUTH_REQUIRED]'),
      deliver: true,
      idempotencyKey: expect.any(String),
      lane: 'alicerealm-bg',
    }, 480_000);

    await services[0].stop();
  });

  test('routes real stream order callbacks to the notifier before HTTP ACK', async () => {
    const serverDir = path.join(alicerealmHome, 'servers', 'alicerealm');
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(path.join(serverDir, 'agent-v2-credentials.json'), JSON.stringify({ access_token: 'test-token' }));
    discoverServersMock.mockResolvedValue({ kind: 'ok', servers: [
      { name: 'alicerealm', endpoint: 'https://alicerealm.com', current: true },
    ] });
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, json: async () => ({ data: { acknowledged: 1 } }),
    } as Response);
    const { AliceRealmNotifier } = await import('./notifier');
    const deliver = jest.spyOn(AliceRealmNotifier.prototype, 'deliverOrder').mockResolvedValue(true);
    const pmDeliver = jest.spyOn(AliceRealmNotifier.prototype, 'deliver').mockResolvedValue(true);
    const { default: plugin } = await import('./index');
    const services: any[] = [];
    plugin.register({ registrationMode: 'full', config: {}, pluginConfig: {}, runtime: {},
      logger: createLogger(), registerService: (service: any) => services.push(service),
      registerCommand: jest.fn(), registerHook: jest.fn(), on: jest.fn(),
    } as any);
    try {
      await services[0].start();
      deliver.mockClear();
      const { AliceRealmStreamClient } = await import('./stream-client');
      const callback = (AliceRealmStreamClient as jest.Mock).mock.calls[0][0].onPmEvent;
      const notification = { notification_id: '358858910188175361', source_type: 'commission_order',
        payload: { order_id: '358858910112677888', recipient_role: 'seller', to_state: 'pending_payment' } };
      await callback({ type: 'notification_push', data: { notifications: [notification] } });
      expect(deliver).toHaveBeenCalledWith(expect.stringContaining('[ALICEREALM_ORDER_NOTIFICATION]'), expect.objectContaining({ key: 'alicerealm::358858910188175361' }));
      expect(deliver).toHaveBeenCalledWith(expect.stringContaining('358858910112677888'), expect.any(Object));
      expect(fetchMock).toHaveBeenCalledWith('https://alicerealm.com/api/v2/notifications/ack', expect.objectContaining({ method: 'POST' }));
      expect(deliver.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]);
      await callback({ type: 'commission_order_notification', notification: { ...notification, notification_id: '358858954874290177' } });
      expect(deliver).toHaveBeenCalledTimes(2);
      await callback({ type: 'pm_push', data: { messages: [{ msg_id: '1', content: 'hi' }] } });
      expect(pmDeliver).toHaveBeenCalledWith(expect.stringContaining('[ALICEREALM_MSG_PAYLOAD]'), expect.any(Object));
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      await services[0].stop();
      fetchMock.mockRestore();
      deliver.mockRestore();
      pmDeliver.mockRestore();
    }
  });

  test('starts feed poller and stream client for each discovered server', async () => {
    const alicerealmDir = path.join(alicerealmHome, 'servers', 'alicerealm');
    const alphaDir = path.join(alicerealmHome, 'servers', 'alpha');
    fs.mkdirSync(alicerealmDir, { recursive: true });
    fs.mkdirSync(alphaDir, { recursive: true });

    discoverServersMock.mockResolvedValue({ kind: 'ok', servers: [
      { name: 'alicerealm', endpoint: 'https://alicerealm.com', current: true },
      { name: 'alpha', endpoint: 'https://alpha.example.com', current: false },
    ] });

    const { default: plugin } = await import('./index');
    const services: any[] = [];

    plugin.register({
      registrationMode: 'full',
      config: {},
      pluginConfig: {},
      runtime: {},
      logger: createLogger(),
      registerService: (service: any) => services.push(service),
      registerCommand: jest.fn(),
      registerHook: jest.fn(),
      on: jest.fn(),
    } as any);

    expect(services).toHaveLength(1);
    await services[0].start();

    // Both pollers and stream clients should be started
    expect(pollingClientStartMock).toHaveBeenCalledTimes(2);
    expect(streamClientStartMock).toHaveBeenCalledTimes(2);

    await services[0].stop();
  });

  test('supports selecting a non-default server with --server', async () => {
    const alicerealmDir = path.join(alicerealmHome, 'servers', 'alicerealm');
    const alphaDir = path.join(alicerealmHome, 'servers', 'alpha');
    fs.mkdirSync(alicerealmDir, { recursive: true });
    fs.mkdirSync(alphaDir, { recursive: true });
    fs.writeFileSync(
      path.join(alphaDir, 'credentials.json'),
      JSON.stringify({ access_token: 'at_alpha_token' }),
      'utf-8'
    );

    discoverServersMock.mockResolvedValue({ kind: 'ok', servers: [
      { name: 'alicerealm', endpoint: 'https://alicerealm.com', current: true },
      { name: 'alpha', endpoint: 'http://127.0.0.1:18080', current: false },
    ] });

    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const commands: any[] = [];
    plugin.register({
      registrationMode: 'full',
      config: {},
      pluginConfig: {},
      runtime: {},
      logger: createLogger(),
      registerService: (service: any) => services.push(service),
      registerCommand: (command: any) => commands.push(command),
      registerHook: jest.fn(),
      on: jest.fn(),
    } as any);

    await services[0].start();

    const authResp = await commands[0].handler({ args: '--server alpha auth' });
    expect(authResp.text).toContain('AliceRealm auth status (server=alpha):');
    expect(authResp.text).toContain('status: available');

    const listResp = await commands[0].handler({ args: 'servers' });
    expect(listResp.text).toContain('AliceRealm servers (discovered via CLI):');
    expect(listResp.text).toContain('- alicerealm:');
    expect(listResp.text).toContain('- alpha:');

    await services[0].stop();
  });

  test('shows pm stream status via /alicerealm pm command', async () => {
    const serverDir = path.join(alicerealmHome, 'servers', 'alicerealm');
    fs.mkdirSync(serverDir, { recursive: true });

    discoverServersMock.mockResolvedValue({ kind: 'ok', servers: [
      { name: 'alicerealm', endpoint: 'http://127.0.0.1:18080', current: true },
    ] });
    streamClientIsRunningMock.mockReturnValue(true);
    streamClientGetLastCursorMock.mockReturnValue('cursor-123');

    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const commands: any[] = [];

    plugin.register({
      registrationMode: 'full',
      config: {},
      pluginConfig: {},
      runtime: {},
      logger: createLogger(),
      registerService: (service: any) => services.push(service),
      registerCommand: (command: any) => commands.push(command),
      registerHook: jest.fn(),
      on: jest.fn(),
    } as any);

    await services[0].start();

    const pmResp = await commands[0].handler({ args: 'pm' });
    expect(pmResp.text).toContain('AliceRealm PM stream status (server=alicerealm):');
    expect(pmResp.text).toContain('streaming: active');
    expect(pmResp.text).toContain('last_cursor: cursor-123');

    await services[0].stop();
  });

  test('delivers install prompt when alicerealm CLI is not installed', async () => {
    discoverServersMock.mockResolvedValue({
      kind: 'not_installed',
      bin: 'alicerealm',
    });

    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const subagentRun = jest.fn().mockResolvedValue({ runId: 'run-install' });

    plugin.register({
      registrationMode: 'full',
      config: {},
      pluginConfig: {},
      runtime: {
        subagent: { run: subagentRun },
      },
      logger: createLogger(),
      registerService: (service: any) => services.push(service),
      registerCommand: jest.fn(),
      registerHook: jest.fn(),
      on: jest.fn(),
    } as any);

    await services[0].start();

    expect(pollingClientStartMock).not.toHaveBeenCalled();
    expect(streamClientStartMock).not.toHaveBeenCalled();
    expect(
      fs.existsSync(path.join(alicerealmHome, 'bootstrap'))
    ).toBe(false);
    expect(subagentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('[ALICEREALM_NOT_INSTALLED]'),
        deliver: true,
      })
    );
    expect(String(subagentRun.mock.calls[0]?.[0]?.message)).toContain(
      'https://github.com/AliceRealm/alicerealm/blob/main/skills/install.md'
    );
    expect(String(subagentRun.mock.calls[0]?.[0]?.message)).toContain('this OpenClaw Agent');
    expect(String(subagentRun.mock.calls[0]?.[0]?.message)).not.toContain('curl -fsSL');
    expect(subagentRun).toHaveBeenCalledTimes(1);

    // second start should not deliver again (guarded) unless stop() resets it
    await services[0].start();
    expect(subagentRun).toHaveBeenCalledTimes(1);

    await services[0].stop();
  });

  test('/alicerealm version invokes CLI version and prints the payload', async () => {
    execAliceRealmMock.mockImplementation(async (_bin: string, args: string[]) => {
      if (args[0] === 'version') {
        return {
          kind: 'success',
          data: { cli_version: '1.2.3', os: 'darwin', arch: 'arm64' },
        };
      }
      return { kind: 'success', data: undefined };
    });

    const { default: plugin } = await import('./index');
    const commands: any[] = [];

    plugin.register({
      registrationMode: 'full',
      config: {},
      pluginConfig: {},
      runtime: {},
      logger: createLogger(),
      registerService: jest.fn(),
      registerCommand: (command: any) => commands.push(command),
      registerHook: jest.fn(),
      on: jest.fn(),
    } as any);

    const resp = await commands[0].handler({ args: 'version' });
    expect(resp.text).toContain('AliceRealm CLI version:');
    expect(resp.text).toContain('"cli_version": "1.2.3"');
    const versionCall = execAliceRealmMock.mock.calls.find(
      ([, args]: any[]) => Array.isArray(args) && args[0] === 'version'
    );
    expect(versionCall).toBeDefined();
  });

  test('lazy discovery returns install instructions when CLI is not installed', async () => {
    discoverServersMock.mockResolvedValue({ kind: 'not_installed', bin: 'alicerealm' });

    const { default: plugin } = await import('./index');
    const commands: any[] = [];

    plugin.register({
      registrationMode: 'full',
      config: {},
      pluginConfig: {},
      runtime: {},
      logger: createLogger(),
      registerService: jest.fn(),
      registerCommand: (command: any) => commands.push(command),
      registerHook: jest.fn(),
      on: jest.fn(),
    } as any);

    const resp = await commands[0].handler({ args: 'auth' });
    expect(resp.text).toContain('AliceRealm CLI not installed');
    expect(resp.text).toContain('https://github.com/AliceRealm/alicerealm/blob/main/skills/install.md');
    expect(resp.text).not.toContain('curl -fsSL');
  });

  test('concurrent commands share a single lazy discovery call', async () => {
    const serverDir = path.join(alicerealmHome, 'servers', 'alicerealm');
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(
      path.join(serverDir, 'credentials.json'),
      JSON.stringify({ access_token: 'at_concurrent' }),
      'utf-8'
    );

    let resolveDiscovery: ((value: any) => void) | null = null;
    discoverServersMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDiscovery = resolve;
        })
    );

    const { default: plugin } = await import('./index');
    const commands: any[] = [];

    plugin.register({
      registrationMode: 'full',
      config: {},
      pluginConfig: {},
      runtime: {},
      logger: createLogger(),
      registerService: jest.fn(),
      registerCommand: (command: any) => commands.push(command),
      registerHook: jest.fn(),
      on: jest.fn(),
    } as any);

    const first = commands[0].handler({ args: 'auth' });
    const second = commands[0].handler({ args: 'auth' });
    const third = commands[0].handler({ args: 'servers' });

    // Wait a tick so both handlers enter ensureRuntimes before discovery resolves.
    await new Promise((r) => setImmediate(r));

    resolveDiscovery!({
      kind: 'ok',
      servers: [{ name: 'alicerealm', endpoint: 'http://127.0.0.1:18080', current: true }],
    });

    await Promise.all([first, second, third]);
    expect(discoverServersMock).toHaveBeenCalledTimes(1);
  });

  test('commands rediscover servers when the discovery service has not populated runtimes', async () => {
    const serverDir = path.join(alicerealmHome, 'servers', 'alicerealm');
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(
      path.join(serverDir, 'credentials.json'),
      JSON.stringify({ access_token: 'at_lazy_token' }),
      'utf-8'
    );

    discoverServersMock.mockResolvedValue({
      kind: 'ok',
      servers: [{ name: 'alicerealm', endpoint: 'http://127.0.0.1:18080', current: true }],
    });

    const { default: plugin } = await import('./index');
    const commands: any[] = [];

    plugin.register({
      registrationMode: 'full',
      config: {},
      pluginConfig: {},
      runtime: {},
      logger: createLogger(),
      registerService: jest.fn(),
      registerCommand: (command: any) => commands.push(command),
      registerHook: jest.fn(),
      on: jest.fn(),
    } as any);

    // Note: discovery service is NOT started — runtimes start empty.
    const authResp = await commands[0].handler({ args: 'auth' });
    expect(authResp.text).toContain('AliceRealm auth status (server=alicerealm):');
    expect(authResp.text).toContain('status: available');
  });

  test('skips registration when registrationMode is not full', async () => {
    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const commands: any[] = [];

    plugin.register({
      registrationMode: 'discovery',
      config: {},
      pluginConfig: {},
      runtime: {},
      logger: createLogger(),
      registerService: (service: any) => services.push(service),
      registerCommand: (command: any) => commands.push(command),
      registerHook: jest.fn(),
      on: jest.fn(),
    } as any);

    expect(services).toHaveLength(0);
    expect(commands).toHaveLength(0);
  });

  test('a retained delivery prevents the next poll without superseding its payload', async () => {
    discoverServersMock.mockResolvedValue({kind:'ok',servers:[{name:'alicerealm',endpoint:'http://127.0.0.1:18080',current:true}]});
    execAliceRealmMock.mockImplementation(async (_bin,args)=>({kind:'success',data:args.includes('heartbeat')
      ? {schema_version:'eigenflux_heartbeat_plan.v1',agent_prompt:'CURRENT PLAN',wake_on_empty:true}
      : undefined}));
    pollingClientStartMock.mockResolvedValue(undefined);
    const {AliceRealmNotifier}=await import('./notifier');
    let complete!: (ok:boolean)=>void;
    const deliver=jest.spyOn(AliceRealmNotifier.prototype,'deliver').mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
    const {default:plugin}=await import('./index');const services:any[]=[];
    plugin.register({registrationMode:'full',config:{},pluginConfig:{},runtime:{},logger:createLogger(),
      registerService:(service:any)=>services.push(service),registerCommand:jest.fn()} as any);
    try {
      await services[0].start();await capturedPollingConfig.onHeartbeatStart();
      expect(capturedPollingConfig.shouldPoll()).toBe(true);
      jest.useFakeTimers();
      await capturedPollingConfig.onFeedPolled({code:0,msg:'success',data:{items:[{item_id:'first'}],notifications:[],has_more:false}});
      await jest.advanceTimersByTimeAsync(0);
      expect(deliver).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(360_000);
      expect(deliver).toHaveBeenCalledTimes(1);
      jest.useRealTimers();
      expect(capturedPollingConfig.shouldPoll()).toBe(false);
      const actual=jest.requireActual('./polling-client') as typeof import('./polling-client');
      const maintenance=jest.fn().mockResolvedValue(undefined);
      const poller=new actual.AliceRealmPollingClient({...capturedPollingConfig,onPollSkipped:maintenance});
      execAliceRealmMock.mockClear();
      expect(await poller.pollOnce()).toEqual({kind:'skipped',reason:'capacity'});
      expect(execAliceRealmMock).not.toHaveBeenCalled();expect(maintenance).toHaveBeenCalledTimes(1);
      complete(true);await new Promise(resolve=>setImmediate(resolve));
      expect(capturedPollingConfig.shouldPoll()).toBe(true);
    } finally {jest.useRealTimers();if(complete)complete(true);await services[0].stop();deliver.mockRestore();}
  });

  test('an unconfirmed Feed run releases capacity without resubmission and the next cycle polls again', async () => {
    discoverServersMock.mockResolvedValue({kind:'ok',servers:[{name:'alicerealm',endpoint:'http://127.0.0.1:18080',current:true}]});
    execAliceRealmMock.mockImplementation(async (_bin,args)=>({kind:'success',data:args.includes('heartbeat')
      ? {schema_version:'eigenflux_heartbeat_plan.v1',agent_prompt:'CURRENT PLAN',wake_on_empty:true}
      : args.includes('poll') ? {items:[],notifications:[],has_more:false} : undefined}));
    pollingClientStartMock.mockResolvedValue(undefined);
    const {AliceRealmNotifier}=await import('./notifier');
    const {UnconfirmedFeedDeliveryError}=await import('./feed-push-scheduler');
    const deliver=jest.spyOn(AliceRealmNotifier.prototype,'deliver')
      .mockRejectedValueOnce(new UnconfirmedFeedDeliveryError('run_id=feed-stuck outcome unconfirmed'))
      .mockResolvedValue(true);
    const {default:plugin}=await import('./index');const services:any[]=[];
    plugin.register({registrationMode:'full',config:{},pluginConfig:{},runtime:{},logger:createLogger(),
      registerService:(service:any)=>services.push(service),registerCommand:jest.fn()} as any);
    try {
      await services[0].start();await capturedPollingConfig.onHeartbeatStart();
      jest.useFakeTimers();
      await capturedPollingConfig.onFeedPolled({code:0,msg:'success',data:{items:[{item_id:'stuck'}],notifications:[],has_more:false}});
      await jest.advanceTimersByTimeAsync(0);
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(capturedPollingConfig.shouldPoll()).toBe(true);
      await jest.advanceTimersByTimeAsync(300_000);
      expect(deliver).toHaveBeenCalledTimes(1);
      jest.useRealTimers();

      const actual=jest.requireActual('./polling-client') as typeof import('./polling-client');
      const poller=new actual.AliceRealmPollingClient(capturedPollingConfig);
      execAliceRealmMock.mockClear();
      expect((await poller.pollOnce()).kind).toBe('success');
      expect(execAliceRealmMock.mock.calls.some(call=>call[1].includes('poll'))).toBe(true);
      await new Promise(resolve=>setImmediate(resolve));
      expect(deliver).toHaveBeenCalledTimes(2);
      expect(deliver.mock.calls[1][0]).not.toContain('stuck');
    } finally {jest.useRealTimers();await services[0].stop();deliver.mockRestore();}
  });
});
