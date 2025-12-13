import { useEffect, useRef } from 'react';
import { useCopilotContext } from '../context/CopilotContext';

export interface UseCopilotReadableOptions {
  /**
   * A description of what this context represents
   */
  description: string;
  /**
   * The value to expose to the LLM. Objects are automatically JSON stringified.
   */
  value: unknown;
  /**
   * Optional parent ID for hierarchical context
   */
  parentId?: string;
}

/**
 * Hook to expose app state/context to the LLM.
 * This helps the LLM understand what data is available and make better decisions
 * about which tools to use.
 *
 * @example
 * ```tsx
 * function TodoList() {
 *   const [todos, setTodos] = useState([]);
 *
 *   // Makes the todo list visible to the LLM
 *   useCopilotReadable({
 *     description: "The current todo list items",
 *     value: todos,
 *   });
 * }
 * ```
 */
export function useCopilotReadable(
  options: UseCopilotReadableOptions,
  dependencies?: unknown[]
): string | undefined {
  const { addReadableContext, removeReadableContext } = useCopilotContext();
  const idRef = useRef<string>();

  const serialized = typeof options.value === 'string'
    ? options.value
    : JSON.stringify(options.value);
  const contextString = `${options.description}: ${serialized}`;

  useEffect(() => {
    const id = addReadableContext(contextString, options.parentId);
    idRef.current = id;

    return () => {
      removeReadableContext(id);
    };
  }, [contextString, options.parentId, addReadableContext, removeReadableContext, ...(dependencies || [])]);

  return idRef.current;
}
