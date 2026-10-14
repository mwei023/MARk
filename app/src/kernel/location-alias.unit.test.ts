import { describe, it, expect } from 'vitest';
import { TaskBinder, matchLocationAlias } from './task-binder.js';
import { homedir, tmpdir } from 'node:os';

const dirListTool: any = {
  id: 'fs.directory_list',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to list. Defaults to the working directory.' },
      limit: { type: 'number', description: 'Max entries.' },
    },
    required: [],
  },
};

describe('location aliases', () => {
  it('matches home/temp forms, nothing else', () => {
    expect(matchLocationAlias('list files in the home directory')).toBe(homedir());
    expect(matchLocationAlias('my portfolio in my home')).toBe(homedir());
    expect(matchLocationAlias('check the temp directory')).toBe(tmpdir());
    expect(matchLocationAlias('list files in /tmp')).toBeUndefined();
    expect(matchLocationAlias('list files')).toBeUndefined();
  });

  it('binds home directory to path-like fields', () => {
    const binder = new TaskBinder();
    const bound = binder.bind('check on my portfolio in the home directory', dirListTool);
    expect(bound.complete).toBe(true);
    expect(bound.input.path).toBe(homedir());
    expect(bound.matchedFields).toContain('path');
  });

  it('leaves ordinary defaults alone', () => {
    const binder = new TaskBinder();
    const bound = binder.bind('list files', dirListTool);
    expect(bound.input.path).toBeUndefined();
  });

  it('explicit field values still win over aliases', () => {
    const binder = new TaskBinder();
    const bound = binder.bind('list files in the home directory with path: /tmp', dirListTool);
    expect(bound.input.path).toBe('/tmp');
  });
});
