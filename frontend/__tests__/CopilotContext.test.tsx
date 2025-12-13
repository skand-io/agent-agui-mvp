import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';

// These imports will fail until we implement them - that's TDD!
import { CopilotProvider, useCopilotContext } from '../src/context/CopilotContext';
import type { CopilotAction } from '../src/types';

// Helper to wrap hooks with provider
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <CopilotProvider>{children}</CopilotProvider>
);

describe('CopilotContext', () => {
  describe('useCopilotContext', () => {
    it('throws error when used outside provider', () => {
      // Suppress console.error for this test
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => {
        renderHook(() => useCopilotContext());
      }).toThrow('useCopilotContext must be used within a CopilotProvider');

      consoleSpy.mockRestore();
    });

    it('provides context value when used within provider', () => {
      const { result } = renderHook(() => useCopilotContext(), { wrapper });

      expect(result.current).toBeDefined();
    });
  });

  describe('context shape', () => {
    it('has messages array', () => {
      const { result } = renderHook(() => useCopilotContext(), { wrapper });

      expect(result.current.messages).toBeDefined();
      expect(Array.isArray(result.current.messages)).toBe(true);
    });

    it('has isLoading boolean', () => {
      const { result } = renderHook(() => useCopilotContext(), { wrapper });

      expect(result.current.isLoading).toBeDefined();
      expect(typeof result.current.isLoading).toBe('boolean');
    });

    it('has actions Map', () => {
      const { result } = renderHook(() => useCopilotContext(), { wrapper });

      expect(result.current.actions).toBeDefined();
      expect(result.current.actions instanceof Map).toBe(true);
    });

    it('has sendMessage function', () => {
      const { result } = renderHook(() => useCopilotContext(), { wrapper });

      expect(result.current.sendMessage).toBeDefined();
      expect(typeof result.current.sendMessage).toBe('function');
    });

    it('has registerAction function', () => {
      const { result } = renderHook(() => useCopilotContext(), { wrapper });

      expect(result.current.registerAction).toBeDefined();
      expect(typeof result.current.registerAction).toBe('function');
    });

    it('has unregisterAction function', () => {
      const { result } = renderHook(() => useCopilotContext(), { wrapper });

      expect(result.current.unregisterAction).toBeDefined();
      expect(typeof result.current.unregisterAction).toBe('function');
    });
  });

  describe('initial state', () => {
    it('starts with empty messages array', () => {
      const { result } = renderHook(() => useCopilotContext(), { wrapper });

      expect(result.current.messages).toEqual([]);
    });

    it('starts with isLoading false', () => {
      const { result } = renderHook(() => useCopilotContext(), { wrapper });

      expect(result.current.isLoading).toBe(false);
    });

    it('starts with empty actions Map', () => {
      const { result } = renderHook(() => useCopilotContext(), { wrapper });

      expect(result.current.actions.size).toBe(0);
    });
  });

  describe('action registration', () => {
    const createTestAction = (name: string): CopilotAction => ({
      name,
      description: `Test action: ${name}`,
      parameters: [
        { name: 'arg1', type: 'string', description: 'Test argument', required: true },
      ],
      handler: () => `Result from ${name}`,
    });

    it('registerAction adds action to actions Map', () => {
      const { result } = renderHook(() => useCopilotContext(), { wrapper });
      const action = createTestAction('testAction');

      act(() => {
        result.current.registerAction(action);
      });

      expect(result.current.actions.has('testAction')).toBe(true);
      expect(result.current.actions.get('testAction')).toEqual(action);
    });

    it('unregisterAction removes action from actions Map', () => {
      const { result } = renderHook(() => useCopilotContext(), { wrapper });
      const action = createTestAction('testAction');

      act(() => {
        result.current.registerAction(action);
      });

      expect(result.current.actions.has('testAction')).toBe(true);

      act(() => {
        result.current.unregisterAction('testAction');
      });

      expect(result.current.actions.has('testAction')).toBe(false);
    });

    it('can register multiple actions', () => {
      const { result } = renderHook(() => useCopilotContext(), { wrapper });
      const action1 = createTestAction('action1');
      const action2 = createTestAction('action2');
      const action3 = createTestAction('action3');

      act(() => {
        result.current.registerAction(action1);
        result.current.registerAction(action2);
        result.current.registerAction(action3);
      });

      expect(result.current.actions.size).toBe(3);
      expect(result.current.actions.has('action1')).toBe(true);
      expect(result.current.actions.has('action2')).toBe(true);
      expect(result.current.actions.has('action3')).toBe(true);
    });

    it('overwrites action when registering with same name', () => {
      const { result } = renderHook(() => useCopilotContext(), { wrapper });
      const action1 = createTestAction('sameAction');
      const action2: CopilotAction = {
        name: 'sameAction',
        description: 'Updated description',
        parameters: [],
        handler: () => 'Updated result',
      };

      act(() => {
        result.current.registerAction(action1);
      });

      expect(result.current.actions.get('sameAction')?.description).toBe('Test action: sameAction');

      act(() => {
        result.current.registerAction(action2);
      });

      expect(result.current.actions.size).toBe(1);
      expect(result.current.actions.get('sameAction')?.description).toBe('Updated description');
    });

    it('unregisterAction does nothing for non-existent action', () => {
      const { result } = renderHook(() => useCopilotContext(), { wrapper });

      // Should not throw
      act(() => {
        result.current.unregisterAction('nonExistent');
      });

      expect(result.current.actions.size).toBe(0);
    });

    it('supports disableFollowUp option', () => {
      const { result } = renderHook(() => useCopilotContext(), { wrapper });
      const action: CopilotAction = {
        name: 'noFollowUp',
        description: 'Action without follow-up',
        parameters: [],
        handler: () => 'Result',
        disableFollowUp: true,
      };

      act(() => {
        result.current.registerAction(action);
      });

      expect(result.current.actions.get('noFollowUp')?.disableFollowUp).toBe(true);
    });
  });
});
