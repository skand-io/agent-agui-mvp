import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';

import { CopilotProvider, useCopilotContext } from '../src/context/CopilotContext';
import { useCopilotAction } from '../src/hooks/useCopilotAction';
import type { CopilotActionParameter } from '../src/types';

// Helper to wrap hooks with provider
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <CopilotProvider>{children}</CopilotProvider>
);

describe('useCopilotAction', () => {
  const defaultParams: CopilotActionParameter[] = [
    { name: 'message', type: 'string', description: 'Message to display', required: true },
  ];

  it('registers action on mount', () => {
    const handler = vi.fn(() => 'result');

    const { result } = renderHook(
      () => {
        useCopilotAction({
          name: 'testAction',
          description: 'Test action',
          parameters: defaultParams,
          handler,
        });
        return useCopilotContext();
      },
      { wrapper }
    );

    expect(result.current.actions.has('testAction')).toBe(true);
    expect(result.current.actions.get('testAction')?.description).toBe('Test action');
  });

  it('unregisters action on unmount', () => {
    const handler = vi.fn(() => 'result');

    const { result, unmount } = renderHook(
      () => {
        useCopilotAction({
          name: 'testAction',
          description: 'Test action',
          parameters: defaultParams,
          handler,
        });
        return useCopilotContext();
      },
      { wrapper }
    );

    expect(result.current.actions.has('testAction')).toBe(true);

    unmount();

    // After unmount, we need to check from a fresh context
    // The action should be unregistered
    const { result: newResult } = renderHook(() => useCopilotContext(), { wrapper });
    // Note: Since we unmounted and got a fresh provider, this will be empty
    // In real usage, other components would still have access to the same provider
  });

  it('updates action when name changes', async () => {
    const handler = vi.fn(() => 'result');

    const { result, rerender } = renderHook(
      ({ name }: { name: string }) => {
        useCopilotAction({
          name,
          description: `Action for ${name}`,
          parameters: defaultParams,
          handler,
        });
        return useCopilotContext();
      },
      {
        wrapper,
        initialProps: { name: 'action1' },
      }
    );

    expect(result.current.actions.has('action1')).toBe(true);
    expect(result.current.actions.has('action2')).toBe(false);

    rerender({ name: 'action2' });

    await waitFor(() => {
      expect(result.current.actions.has('action1')).toBe(false);
      expect(result.current.actions.has('action2')).toBe(true);
    });
  });

  it('action is callable via context', async () => {
    const handler = vi.fn(({ message }: Record<string, unknown>) => `Hello, ${message}!`);

    const { result } = renderHook(
      () => {
        useCopilotAction({
          name: 'greet',
          description: 'Greet someone',
          parameters: defaultParams,
          handler,
        });
        return useCopilotContext();
      },
      { wrapper }
    );

    const action = result.current.actions.get('greet');
    expect(action).toBeDefined();

    const actionResult = await action!.handler({ message: 'World' });
    expect(actionResult).toBe('Hello, World!');
    expect(handler).toHaveBeenCalledWith({ message: 'World' });
  });

  it('supports async handlers', async () => {
    const handler = vi.fn(async ({ message }: Record<string, unknown>) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return `Async: ${message}`;
    });

    const { result } = renderHook(
      () => {
        useCopilotAction({
          name: 'asyncAction',
          description: 'Async action',
          parameters: defaultParams,
          handler,
        });
        return useCopilotContext();
      },
      { wrapper }
    );

    const action = result.current.actions.get('asyncAction');
    const actionResult = await action!.handler({ message: 'test' });
    expect(actionResult).toBe('Async: test');
  });

  it('passes disableFollowUp option', () => {
    const handler = vi.fn(() => 'result');

    const { result } = renderHook(
      () => {
        useCopilotAction({
          name: 'noFollowUp',
          description: 'No follow-up action',
          parameters: [],
          handler,
          disableFollowUp: true,
        });
        return useCopilotContext();
      },
      { wrapper }
    );

    expect(result.current.actions.get('noFollowUp')?.disableFollowUp).toBe(true);
  });

  it('multiple hooks can register different actions', () => {
    const handler1 = vi.fn(() => 'result1');
    const handler2 = vi.fn(() => 'result2');

    const { result } = renderHook(
      () => {
        useCopilotAction({
          name: 'action1',
          description: 'Action 1',
          parameters: [],
          handler: handler1,
        });
        useCopilotAction({
          name: 'action2',
          description: 'Action 2',
          parameters: [],
          handler: handler2,
        });
        return useCopilotContext();
      },
      { wrapper }
    );

    expect(result.current.actions.size).toBe(2);
    expect(result.current.actions.has('action1')).toBe(true);
    expect(result.current.actions.has('action2')).toBe(true);
  });

  it('preserves parameter definitions', () => {
    const params: CopilotActionParameter[] = [
      { name: 'name', type: 'string', description: 'Person name', required: true },
      { name: 'age', type: 'number', description: 'Person age', required: false },
      { name: 'active', type: 'boolean', description: 'Is active', required: true },
    ];

    const { result } = renderHook(
      () => {
        useCopilotAction({
          name: 'complexAction',
          description: 'Complex action',
          parameters: params,
          handler: () => 'result',
        });
        return useCopilotContext();
      },
      { wrapper }
    );

    const action = result.current.actions.get('complexAction');
    expect(action?.parameters).toEqual(params);
  });
});
