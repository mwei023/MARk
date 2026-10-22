/**
 * Shared goal-intent vocabulary.
 *
 * A goal that MATCHES this pattern is an ACTION request: it names a
 * state-changing verb, so the kernel may compose/execute plans whose steps
 * are non-read tools (subject to authority: standing trust, confirmation).
 *
 * A goal that does NOT match is assumed to be a read/knowledge goal unless
 * proven otherwise. Plans for read goals must be read-only — this is the
 * plan-intent rule enforced in goal-execution. Observed live: an
 * availability question ("is the web agent available") was planned with a
 * desktop.open.* browser launch; every such ask pends a confirmation that
 * nobody is there to answer, and the backlog grows on every pass.
 */
export const ACTION_GOAL_RE =
  /\b(play|launch|start|restart|stop|send|delete|remove|create|write|minimize|minimise|maximize|maximise|raise|open)\b/i;
