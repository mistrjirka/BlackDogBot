import { describe, it, expect } from 'vitest';
import { splitTelegramMessage } from '../../src/utils/telegram-message.js';

describe('splitTelegramMessage', () => {
  it('should return single element for short messages', () => {
    const result: string[] = splitTelegramMessage('Hello world');
    expect(result).toEqual(['Hello world']);
  });

  it('should return single element for exactly max length', () => {
    const text: string = 'a'.repeat(100);
    const result: string[] = splitTelegramMessage(text, 100);
    expect(result).toEqual([text]);
  });

  it('should split at double newlines', () => {
    const text: string = 'First paragraph' + '\n\n' + 'Second paragraph that pushes over the limit';
    const result: string[] = splitTelegramMessage(text, 50);
    expect(result.length).toBe(2);
    expect(result[0]).toBe('First paragraph');
    expect(result[1]).toBe('Second paragraph that pushes over the limit');
  });

  it('should split at single newlines when no double newlines', () => {
    const text: string = 'Line one\nLine two that is quite long';
    const result: string[] = splitTelegramMessage(text, 30);
    expect(result.length).toBe(2);
    expect(result[0]).toBe('Line one');
    expect(result[1]).toBe('Line two that is quite long');
  });

  it('should hard split when no newlines available', () => {
    const text: string = 'a'.repeat(150);
    const result: string[] = splitTelegramMessage(text, 100);
    expect(result.length).toBe(2);
    expect(result[0]).toBe('a'.repeat(100));
    expect(result[1]).toBe('a'.repeat(50));
  });

  it('should handle empty string', () => {
    const result: string[] = splitTelegramMessage('');
    expect(result).toEqual(['']);
  });

  it('should handle multiple splits', () => {
    const text: string = 'A'.repeat(50) + '\n\n' + 'B'.repeat(50) + '\n\n' + 'C'.repeat(50);
    const result: string[] = splitTelegramMessage(text, 60);
    expect(result.length).toBe(3);
    expect(result[0]).toBe('A'.repeat(50));
    expect(result[1]).toBe('B'.repeat(50));
    expect(result[2]).toBe('C'.repeat(50));
  });

  it('should use default 4096 max length', () => {
    const shortText: string = 'a'.repeat(4096);
    expect(splitTelegramMessage(shortText)).toEqual([shortText]);
    
    const longText: string = 'a'.repeat(4097);
    expect(splitTelegramMessage(longText).length).toBe(2);
  });
});
