import { AliceRealmSettingsReporter, resolveAgentMode } from './settings-reporter';
import { Logger } from './logger';
import type { CliResult } from './cli-executor';

jest.mock('./cli-executor');

import { execAliceRealm } from './cli-executor';

const execMock = execAliceRealm as jest.MockedFunction<typeof execAliceRealm>;

function createLoggerSpies() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function createLogger(spies = createLoggerSpies()): Logger {
  return new Logger(spies);
}

describe('resolveAgentMode', () => {
  test('ignores a stale skill channel for the native plugin loop', () => {
    expect(resolveAgentMode({ ALICEREALM_CHANNEL: 'skill' })).toBe('plugin');
  });

  test('maps explicit ALICEREALM_CHANNEL=plugin to plugin', () => {
    expect(resolveAgentMode({ ALICEREALM_CHANNEL: 'plugin' })).toBe('plugin');
  });

  test('maps openclaw host signal to plugin', () => {
    expect(resolveAgentMode({ ALICEREALM_HOST: 'openclaw/0.0.14' })).toBe('plugin');
  });

  test('maps openclaw channel to plugin', () => {
    expect(resolveAgentMode({ ALICEREALM_CHANNEL: 'openclaw' })).toBe('plugin');
  });

  test('routing channels do not override the actual loop owner', () => {
    expect(
      resolveAgentMode({ ALICEREALM_CHANNEL: 'skill', ALICEREALM_HOST: 'openclaw/1.0' })
    ).toBe('plugin');
  });

  test('the polling service reports plugin without environment hints', () => {
    expect(resolveAgentMode({})).toBe('plugin');
    expect(resolveAgentMode({ ALICEREALM_CHANNEL: 'discord' })).toBe('plugin');
  });
});

describe('AliceRealmSettingsReporter', () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  test.each([
    ['settings unchanged; nothing to report', 'unchanged'],
    ['settings reported', 'reported'],
    ['', 'completed'],
  ])('reports the CLI result without inventing a network write: %s', async (output, status) => {
    const spies = createLoggerSpies();
    execMock.mockResolvedValue({ kind: 'success', data: output });
    const reporter = new AliceRealmSettingsReporter({
      serverName: 'srv', alicerealmBin: 'alicerealm', logger: createLogger(spies),
    });
    expect(await reporter.report()).toBe(true);
    expect(spies.info).toHaveBeenCalledWith(expect.stringContaining(`Agent settings ${status}`));
  });

  test('invokes `settings push --mode <mode>` once on a successful poll', async () => {
    execMock.mockResolvedValue({ kind: 'success', data: '' } as CliResult<any>);

    const reporter = new AliceRealmSettingsReporter({
      serverName: 'srv',
      alicerealmBin: '/usr/bin/alicerealm',
      logger: createLogger(),
      resolveMode: () => 'plugin',
    });

    const ok = await reporter.report();

    expect(ok).toBe(true);
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock).toHaveBeenCalledWith(
      '/usr/bin/alicerealm',
      ['settings', 'push', '--mode', 'plugin', '-s', 'srv'],
      expect.objectContaining({ parseJson: false })
    );
  });

  test('passes through skill mode', async () => {
    execMock.mockResolvedValue({ kind: 'success', data: '' } as CliResult<any>);

    const reporter = new AliceRealmSettingsReporter({
      serverName: 'srv',
      alicerealmBin: 'alicerealm',
      logger: createLogger(),
      resolveMode: () => 'skill',
    });

    await reporter.report();
    expect(execMock).toHaveBeenCalledWith(
      'alicerealm',
      ['settings', 'push', '--mode', 'skill', '-s', 'srv'],
      expect.any(Object)
    );
  });

  test('omits --mode when mode cannot be determined', async () => {
    execMock.mockResolvedValue({ kind: 'success', data: '' } as CliResult<any>);

    const reporter = new AliceRealmSettingsReporter({
      serverName: 'srv',
      alicerealmBin: 'alicerealm',
      logger: createLogger(),
      resolveMode: () => undefined,
    });

    const ok = await reporter.report();

    expect(ok).toBe(true);
    expect(execMock).toHaveBeenCalledWith(
      'alicerealm',
      ['settings', 'push', '-s', 'srv'],
      expect.any(Object)
    );
  });

  test('default resolveMode uses env (openclaw host -> plugin)', async () => {
    const prev = { ...process.env };
    process.env.ALICEREALM_HOST = 'openclaw/0.0.14';
    delete process.env.ALICEREALM_CHANNEL;
    execMock.mockResolvedValue({ kind: 'success', data: '' } as CliResult<any>);

    try {
      const reporter = new AliceRealmSettingsReporter({
        serverName: 'srv',
        alicerealmBin: 'alicerealm',
        logger: createLogger(),
      });
      await reporter.report();
      expect(execMock).toHaveBeenCalledWith(
        'alicerealm',
        ['settings', 'push', '--mode', 'plugin', '-s', 'srv'],
        expect.any(Object)
      );
    } finally {
      process.env = prev;
    }
  });

  test('does not throw when CLI returns an error (best-effort)', async () => {
    const spies = createLoggerSpies();
    execMock.mockResolvedValue({
      kind: 'error',
      error: new Error('connection refused'),
      exitCode: 1,
      stderr: 'boom',
    } as CliResult<any>);

    const reporter = new AliceRealmSettingsReporter({
      serverName: 'srv',
      alicerealmBin: 'alicerealm',
      logger: createLogger(spies),
      resolveMode: () => 'plugin',
    });

    const ok = await reporter.report();
    expect(ok).toBe(false);
    expect(spies.warn).toHaveBeenCalledWith(expect.stringContaining('Settings push failed'));
  });

  test('does not throw when CLI returns auth_required', async () => {
    const spies = createLoggerSpies();
    execMock.mockResolvedValue({ kind: 'auth_required', stderr: '' } as CliResult<any>);

    const reporter = new AliceRealmSettingsReporter({
      serverName: 'srv',
      alicerealmBin: 'alicerealm',
      logger: createLogger(spies),
      resolveMode: () => 'plugin',
    });

    expect(await reporter.report()).toBe(false);
    expect(spies.warn).toHaveBeenCalledWith(expect.stringContaining('auth required'));
  });

  test('does not throw when CLI is not installed', async () => {
    const spies = createLoggerSpies();
    execMock.mockResolvedValue({ kind: 'not_installed', bin: 'alicerealm' } as CliResult<any>);

    const reporter = new AliceRealmSettingsReporter({
      serverName: 'srv',
      alicerealmBin: 'alicerealm',
      logger: createLogger(spies),
      resolveMode: () => 'plugin',
    });

    expect(await reporter.report()).toBe(false);
    expect(spies.warn).toHaveBeenCalledWith(expect.stringContaining('not installed'));
  });

  test('swallows a thrown exec error', async () => {
    const spies = createLoggerSpies();
    execMock.mockRejectedValue(new Error('spawn failure'));

    const reporter = new AliceRealmSettingsReporter({
      serverName: 'srv',
      alicerealmBin: 'alicerealm',
      logger: createLogger(spies),
      resolveMode: () => 'plugin',
    });

    await expect(reporter.report()).resolves.toBe(false);
    expect(spies.warn).toHaveBeenCalledWith(expect.stringContaining('Settings push crashed'));
  });

  test('skips concurrent report while one is in flight (no duplicate spawn)', async () => {
    let resolveExec!: (v: CliResult<any>) => void;
    execMock.mockImplementation(
      () =>
        new Promise<CliResult<any>>((res) => {
          resolveExec = res;
        })
    );

    const reporter = new AliceRealmSettingsReporter({
      serverName: 'srv',
      alicerealmBin: 'alicerealm',
      logger: createLogger(),
      resolveMode: () => 'plugin',
    });

    const first = reporter.report();
    const second = await reporter.report(); // in-flight → skipped
    expect(second).toBe(false);
    expect(execMock).toHaveBeenCalledTimes(1);

    resolveExec({ kind: 'success', data: '' } as CliResult<any>);
    expect(await first).toBe(true);
  });
});
