// The SDK plugin-entry module is ESM-only and cannot load under Jest's CJS
// transform; mock it so importing ./index (for the exported syncPluginSkills)
// succeeds. Mirrors the mock in index.test.ts.
jest.mock('openclaw/plugin-sdk/plugin-entry', () => ({
  definePluginEntry: (opts: any) => opts,
  buildJsonPluginConfigSchema: (schema: any) => schema,
}));

// Intercept the CLI subprocess so no real `alicerealm` is spawned.
const execAliceRealmMock = jest.fn();
jest.mock('./cli-executor', () => ({
  execAliceRealm: (...args: any[]) => execAliceRealmMock(...args),
}));

import { syncPluginSkills } from './index';
import type { Logger } from './logger';

function makeLogger(): Logger {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as Logger;
}

describe('syncPluginSkills (startup skill auto-update)', () => {
  beforeEach(() => execAliceRealmMock.mockReset());

  it('syncs from R2 into the OpenClaw host skills dir and refreshes the snapshot', async () => {
    execAliceRealmMock.mockResolvedValue({ kind: 'success', data: undefined });
    const logger = makeLogger();
    const refreshSnapshot = jest.fn();

    await syncPluginSkills('alicerealm', logger, refreshSnapshot);

    expect(execAliceRealmMock).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = execAliceRealmMock.mock.calls[0];
    expect(bin).toBe('alicerealm');
    expect(args).toEqual(['skills', 'sync', '--if-stale', '--quiet', '--host', 'openclaw']);
    expect(args).not.toContain('--into');
    expect(opts).toMatchObject({ parseJson: false });
    expect(refreshSnapshot).toHaveBeenCalledTimes(1);
    expect((logger.info as jest.Mock)).toHaveBeenCalled();
  });

  it('never throws and logs a warning when the CLI returns a non-success kind', async () => {
    execAliceRealmMock.mockResolvedValue({
      kind: 'error',
      error: new Error('boom'),
      exitCode: 1,
      stderr: 'boom',
    });
    const logger = makeLogger();
    const refreshSnapshot = jest.fn();

    await expect(syncPluginSkills('alicerealm', logger, refreshSnapshot)).resolves.toBeUndefined();
    expect(refreshSnapshot).not.toHaveBeenCalled();
    expect((logger.warn as jest.Mock)).toHaveBeenCalled();
  });

  it('never throws when execAliceRealm itself rejects', async () => {
    execAliceRealmMock.mockRejectedValue(new Error('spawn failed'));
    const logger = makeLogger();
    const refreshSnapshot = jest.fn();

    await expect(syncPluginSkills('alicerealm', logger, refreshSnapshot)).resolves.toBeUndefined();
    expect(refreshSnapshot).not.toHaveBeenCalled();
    expect((logger.warn as jest.Mock)).toHaveBeenCalled();
  });
});
