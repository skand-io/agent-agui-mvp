import { useEffect, useRef } from 'react';
import { useCopilotContext } from '../context/CopilotContext';
import type { CopilotActionParameter } from '../types';

export interface UseCopilotActionOptions {
  name: string;
  description: string;
  parameters: CopilotActionParameter[];
  handler: (args: Record<string, unknown>) => string | Promise<string>;
  disableFollowUp?: boolean;
}

export function useCopilotAction(options: UseCopilotActionOptions): void {
  const { registerAction, unregisterAction } = useCopilotContext();
  const prevNameRef = useRef<string | null>(null);

  useEffect(() => {
    // If name changed, unregister the old action first
    if (prevNameRef.current && prevNameRef.current !== options.name) {
      unregisterAction(prevNameRef.current);
    }

    registerAction({
      name: options.name,
      description: options.description,
      parameters: options.parameters,
      handler: options.handler,
      disableFollowUp: options.disableFollowUp,
    });

    prevNameRef.current = options.name;

    return () => {
      unregisterAction(options.name);
    };
  }, [
    options.name,
    options.description,
    options.disableFollowUp,
    JSON.stringify(options.parameters),
    registerAction,
    unregisterAction,
  ]);
}
