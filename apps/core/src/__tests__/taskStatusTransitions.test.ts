import { describe, expect, it } from 'vitest';
import { isValidTransition } from '../web/taskStatusTransitions.js';

describe('taskStatusTransitions', () => {
  it('允许合法状态流转', () => {
    expect(isValidTransition('todo', 'in_progress')).toBe(true);
    expect(isValidTransition('in_progress', 'in_review')).toBe(true);
    expect(isValidTransition('in_progress', 'done')).toBe(true);
    expect(isValidTransition('in_review', 'done')).toBe(true);
    expect(isValidTransition('in_review', 'in_progress')).toBe(true);
  });

  it('拒绝非法状态流转', () => {
    expect(isValidTransition('todo', 'done')).toBe(false);
    expect(isValidTransition('todo', 'in_review')).toBe(false);
    expect(isValidTransition('done', 'todo')).toBe(false);
    expect(isValidTransition('done', 'in_progress')).toBe(false);
  });
});
