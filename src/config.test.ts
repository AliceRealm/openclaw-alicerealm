import * as os from 'os';

const execAliceRealmMock = jest.fn();
jest.mock('./cli-executor', () => ({
  execAliceRealm: (...args: any[]) => execAliceRealmMock(...args),
}));

import {
  PLUGIN_CONFIG,
  resolvePluginConfig,
  resolveAliceRealmHome,
  discoverServers,
  getInstalledCliVersion,
  isCliOutdated,
} from './config';

const packageManifest = require('../package.json') as { version: string };
const pluginManifest = require('../openclaw.plugin.json') as {
  version: string;
  contracts: { tools: string[] };
};

describe('resolvePluginConfig', () => {
  test('returns defaults when config is empty', () => {
    const config = resolvePluginConfig({});

    expect(config.alicerealmBin).toBe(PLUGIN_CONFIG.DEFAULT_ALICEREALM_BIN);
    expect(config.skills).toEqual(['ar-broadcast', 'ar-communication']);
    expect(config.openclawCliBin).toBe(PLUGIN_CONFIG.DEFAULT_OPENCLAW_CLI_BIN);
    expect(config.serverRouting).toEqual({});
  });

  test('resolves custom alicerealmBin and openclawCliBin', () => {
    const config = resolvePluginConfig({
      alicerealmBin: '/opt/bin/alicerealm',
      openclawCliBin: '/opt/bin/openclaw',
    });

    expect(config.alicerealmBin).toBe('/opt/bin/alicerealm');
    expect(config.openclawCliBin).toBe('/opt/bin/openclaw');
  });

  test('resolves custom skills array', () => {
    const config = resolvePluginConfig({
      skills: ['ar-broadcast', 'ar-profile', 'custom-skill'],
    });

    expect(config.skills).toEqual(['ar-broadcast', 'ar-profile', 'custom-skill']);
  });

  test('filters out non-string and empty skills entries', () => {
    const config = resolvePluginConfig({
      skills: ['ar-broadcast', '', 42, null, 'ar-communication'] as any,
    });

    expect(config.skills).toEqual(['ar-broadcast', 'ar-communication']);
  });

  test('resolves serverRouting with defaults for missing fields', () => {
    const config = resolvePluginConfig({
      serverRouting: {
        alpha: {
          sessionKey: 'agent:ops:feishu:direct:ou_alpha',
        },
      },
    });

    const routing = config.serverRouting['alpha'];
    expect(routing).toBeDefined();
    expect(routing.sessionKey).toBe('agent:ops:feishu:direct:ou_alpha');
    expect(routing.agentId).toBe('ops');
    expect(routing.replyChannel).toBe('feishu');
    expect(routing.replyTo).toBe('user:ou_alpha');
  });

  test('ignores schema-defaulted main session fields so route discovery stays automatic', () => {
    const config = resolvePluginConfig({
      serverRouting: {
        alicerealm: {
          sessionKey: 'main',
          agentId: 'main',
        },
      },
    });

    const routing = config.serverRouting['alicerealm'];
    expect(routing).toBeDefined();
    expect(routing.routeOverrides).toEqual({
      sessionKey: false,
      agentId: false,
      replyChannel: false,
      replyTo: false,
      replyAccountId: false,
    });
  });

});

describe('resolveAliceRealmHome', () => {
  const originalEnv = process.env.ALICEREALM_HOME;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ALICEREALM_HOME;
    } else {
      process.env.ALICEREALM_HOME = originalEnv;
    }
  });

  test('defaults to ~/.alicerealm when ALICEREALM_HOME is not set', () => {
    delete process.env.ALICEREALM_HOME;

    const home = resolveAliceRealmHome();
    expect(home).toBe(`${os.homedir()}/.alicerealm`);
  });

  test('uses ALICEREALM_HOME env var with .alicerealm suffix appended', () => {
    process.env.ALICEREALM_HOME = '/custom/path';

    const home = resolveAliceRealmHome();
    expect(home).toBe('/custom/path/.alicerealm');
  });

  test('does not double-append .alicerealm if already present', () => {
    process.env.ALICEREALM_HOME = '/custom/path/.alicerealm';

    const home = resolveAliceRealmHome();
    expect(home).toBe('/custom/path/.alicerealm');
  });

  test('uses baseDir when ALICEREALM_HOME is not set', () => {
    delete process.env.ALICEREALM_HOME;

    const home = resolveAliceRealmHome('/opt/openclaw/plugins/alicerealm');
    expect(home).toBe('/opt/openclaw/plugins/alicerealm/.alicerealm');
  });

  test('ALICEREALM_HOME takes precedence over baseDir', () => {
    process.env.ALICEREALM_HOME = '/explicit/override';

    const home = resolveAliceRealmHome('/opt/openclaw/plugins/alicerealm');
    expect(home).toBe('/explicit/override/.alicerealm');
  });
});

describe('discoverServers', () => {
  beforeEach(() => {
    execAliceRealmMock.mockReset();
  });

  test('calls alicerealm with server list --format json', async () => {
    execAliceRealmMock.mockResolvedValue({ kind: 'success', data: [] });
    await discoverServers('alicerealm');
    expect(execAliceRealmMock).toHaveBeenCalledWith(
      'alicerealm',
      ['server', 'list', '--format', 'json'],
      expect.any(Object)
    );
  });

  test('returns ok with parsed servers on success', async () => {
    execAliceRealmMock.mockResolvedValue({
      kind: 'success',
      data: [{ name: 'alicerealm', endpoint: 'https://x', current: true }],
    });
    const result = await discoverServers('alicerealm');
    expect(result).toEqual({
      kind: 'ok',
      servers: [{ name: 'alicerealm', endpoint: 'https://x', current: true }],
    });
  });

  test('surfaces not_installed when the executor reports it', async () => {
    execAliceRealmMock.mockResolvedValue({ kind: 'not_installed', bin: 'alicerealm' });
    const result = await discoverServers('alicerealm');
    expect(result).toEqual({ kind: 'not_installed', bin: 'alicerealm' });
  });

  test('preserves a successful empty configuration', async () => {
    execAliceRealmMock.mockResolvedValue({ kind: 'success', data: [] });
    expect(await discoverServers('alicerealm')).toEqual({ kind: 'ok', servers: [] });
  });

  test.each([undefined, {}, [{ name: 'missing-endpoint' }], [null]])(
    'classifies malformed server data as a retryable discovery error: %p', async (data) => {
      execAliceRealmMock.mockResolvedValue({ kind: 'success', data });
      expect(await discoverServers('alicerealm')).toEqual({
        kind: 'error', error: expect.stringContaining('invalid server list'), retryable: true,
      });
    }
  );

  test('preserves command failures instead of presenting an empty configuration', async () => {
    execAliceRealmMock.mockResolvedValue({ kind: 'error', error: new Error('CLI timed out') });
    expect(await discoverServers('alicerealm')).toEqual({
      kind: 'error', error: 'CLI timed out', retryable: true,
    });
  });

  test('authentication failures require recovery rather than automatic discovery retries', async () => {
    execAliceRealmMock.mockResolvedValue({ kind: 'auth_required', stderr: 'expired' });
    expect(await discoverServers('alicerealm')).toEqual({
      kind: 'error', error: expect.stringContaining('requires authentication'), retryable: false,
    });
  });
});

describe('PLUGIN_CONFIG metadata', () => {
  test('keeps runtime metadata aligned with manifests', () => {
    expect(PLUGIN_CONFIG.PLUGIN_VERSION).toBe(packageManifest.version);
    expect(PLUGIN_CONFIG.PLUGIN_VERSION).toBe(pluginManifest.version);
    expect(PLUGIN_CONFIG.HOST_KIND).toBe('openclaw');
  });

  test('declares every registered agent tool in the plugin contract', () => {
    expect(pluginManifest.contracts.tools).toEqual(['alicerealm__followup']);
  });

  test('exports expected constant keys', () => {
    expect(PLUGIN_CONFIG.DEFAULT_ALICEREALM_BIN).toBe('alicerealm');
    expect(PLUGIN_CONFIG.DEFAULT_SESSION_KEY).toBe('main');
    expect(PLUGIN_CONFIG.DEFAULT_AGENT_ID).toBe('main');
  });

  test('declares an expected CLI version', () => {
    expect(PLUGIN_CONFIG.EXPECTED_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/u);
  });
});

describe('isCliOutdated', () => {
  test('true when installed is older than target', () => {
    expect(isCliOutdated('0.0.12', '0.0.13')).toBe(true);
    expect(isCliOutdated('0.1.0', '1.0.0')).toBe(true);
    expect(isCliOutdated('1.2.3', '1.3.0')).toBe(true);
  });

  test('false when installed is equal or newer', () => {
    expect(isCliOutdated('0.0.13', '0.0.13')).toBe(false);
    expect(isCliOutdated('0.0.14', '0.0.13')).toBe(false);
    expect(isCliOutdated('1.0.0', '0.9.9')).toBe(false);
  });

  test('false (no nag) on null or unparseable input', () => {
    expect(isCliOutdated(null, '0.0.13')).toBe(false);
    expect(isCliOutdated('garbage', '0.0.13')).toBe(false);
    expect(isCliOutdated('', '0.0.13')).toBe(false);
  });

  test('tolerates suffixes on the patch segment', () => {
    expect(isCliOutdated('0.0.12-rc1', '0.0.13')).toBe(true);
    expect(isCliOutdated('0.0.13+abc', '0.0.13')).toBe(false);
  });
});

describe('getInstalledCliVersion', () => {
  beforeEach(() => execAliceRealmMock.mockReset());

  test('returns cli_version from `alicerealm version` JSON', async () => {
    execAliceRealmMock.mockResolvedValue({ kind: 'success', data: { cli_version: '0.0.12' } });
    await expect(getInstalledCliVersion('alicerealm')).resolves.toBe('0.0.12');
    expect(execAliceRealmMock).toHaveBeenCalledWith('alicerealm', ['version'], expect.anything());
  });

  test('returns null when CLI is missing or version absent', async () => {
    execAliceRealmMock.mockResolvedValue({ kind: 'not_installed', bin: 'alicerealm' });
    await expect(getInstalledCliVersion('alicerealm')).resolves.toBeNull();
    execAliceRealmMock.mockResolvedValue({ kind: 'success', data: {} });
    await expect(getInstalledCliVersion('alicerealm')).resolves.toBeNull();
  });
});
