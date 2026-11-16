import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectOpenClawContext } from './openclaw-context';
import { Logger } from './logger';

test('profile task deliveries are excluded from user context while ordinary turns remain', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'alicerealm-context-'));
  const sessions = join(stateDir, 'agents', 'main', 'sessions');
  mkdirSync(sessions, { recursive: true });
  const task = [
    'ALICEREALM PROFILE REVIEW TASK',
    "CLI prefix: alicerealm --homedir '/agent/.alicerealm' --server 'test'",
    'Freshly read /skills/ar-profile/SKILL.md and /skills/ar-broadcast/SKILL.md. Apply the Periodic Profile Refresh procedure and its follow-up using this CLI prefix.',
    'Host context (data):',
    '{"memory":[],"session":["previous work"]}',
  ].join('\n');
  const entries = [
    { message: { role: 'user', content: 'Investigating deployment latency' } },
    { message: { role: 'user', content: task } },
    { message: { role: 'assistant', content: [{ type: 'text', text: task }] } },
    { message: { role: 'user', content: 'Your AliceRealm profile is due for its daily refresh' } },
    { message: { role: 'user', content: 'AliceRealm feed payload received' } },
    { message: { role: 'assistant', content: 'The next step is to measure queue time' } },
  ];
  writeFileSync(join(sessions, 'session.jsonl'), entries.map((entry) => JSON.stringify(entry)).join('\n'));
  const logger = new Logger({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() });
  try {
    expect(collectOpenClawContext(stateDir, logger).sessionSnippets).toEqual([
      'Investigating deployment latency', 'The next step is to measure queue time',
    ]);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
