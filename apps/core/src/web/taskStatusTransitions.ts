import type { TaskInfo } from '@agent-collab/protocol';

const VALID_TRANSITIONS: Record<TaskInfo['status'], TaskInfo['status'][]> = {
  todo: ['in_progress'],
  in_progress: ['in_review', 'done'],
  in_review: ['done', 'in_progress'],
  done: [],
};

export function isValidTransition(from: TaskInfo['status'], to: TaskInfo['status']): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}
