import { describe, it, expect } from 'vitest';
import { DEFAULT_AGENT_MAX_STEPS } from '../../src/shared/constants.js';

describe('DEFAULT_AGENT_MAX_STEPS', () => {
  it('should be at least 150', () => {
    const minimumSteps: number = 150;
    expect(DEFAULT_AGENT_MAX_STEPS).toBeGreaterThanOrEqual(minimumSteps);
  });
});
