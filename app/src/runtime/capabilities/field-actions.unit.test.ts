/** Phase 2 merge proof: evidence tools auto-grade read, GUI-mutating tools gate. */
import { describe, it, expect } from 'vitest';
import { agentActionRisk, unifiedEvaluate } from '../../kernel/policy-bridge.js';
import {
  FieldCamshotCapability,
  FieldClickCapability,
  FieldScreenshotCapability,
  FieldTypeCapability,
} from './field-actions.js';

describe('field action risk vocabulary', () => {
  it('grades evidence tools as read', () => {
    expect(agentActionRisk('field_screenshot')).toBe('read');
    expect(agentActionRisk('field_camshot')).toBe('read');
    expect(agentActionRisk('screenshot')).toBe('read');
  });

  it('grades GUI actions as mutating (gated)', () => {
    expect(agentActionRisk('field_click')).toBe('mutating');
    expect(agentActionRisk('field_type')).toBe('mutating');
    expect(agentActionRisk('field_send_message')).toBe('mutating');
  });

  it('gates mutating field actions behind block/confirm', () => {
    const gated = unifiedEvaluate({
      agentName: 'test', action: 'field_click', risk: 'low', isFirst: true,
    });
    expect(['block', 'confirm', 'alert']).toContain(gated.decision);
  });

  it('does not block read-only evidence in dev', () => {
    const shot = unifiedEvaluate({
      agentName: 'test', action: 'field_screenshot', risk: 'low', isFirst: true,
    });
    expect(shot.decision).not.toBe('block');
  });
});

describe('field action triggers', () => {
  it('screenshot/camshot match evidence requests', () => {
    expect(new FieldScreenshotCapability().canHandle('take a screenshot')).toBe(true);
    expect(new FieldCamshotCapability().canHandle('take a picture of me')).toBe(true);
    expect(new FieldScreenshotCapability().canHandle('restart the router')).toBe(false);
  });

  it('click/type demand explicit targets (no accidental triggers)', () => {
    expect(new FieldClickCapability().canHandle('click at 1125,623')).toBe(true);
    expect(new FieldClickCapability().canHandle('click that button')).toBe(false);
    expect(new FieldTypeCapability().canHandle('type text: hello')).toBe(true);
    expect(new FieldTypeCapability().canHandle('what type of router is this')).toBe(false);
  });
});
