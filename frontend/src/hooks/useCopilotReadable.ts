import { useEffect, useRef } from 'react';
import { useCopilotContext } from '../context/CopilotContext';

/**
 * Options for the useCopilotReadable hook.
 * Matches CopilotKit's API.
 */
export interface UseCopilotReadableOptions {
  /**
   * The description of the information to be added to the Copilot context.
   */
  description: string;
  /**
   * The value to be added to the Copilot context. Object values are automatically stringified.
   */
  value: unknown;
  /**
   * The ID of the parent context, if any.
   */
  parentId?: string;
  /**
   * An array of categories to control which contexts are visible where.
   */
  categories?: string[];
  /**
   * Whether the context is available to the Copilot.
   */
  available?: 'enabled' | 'disabled';
  /**
   * A custom conversion function to use to serialize the value to a string.
   * If not provided, the value will be serialized using JSON.stringify.
   */
  convert?: (description: string, value: unknown) => string;
}

function convertToJSON(description: string, value: unknown): string {
  return `${description}: ${typeof value === 'string' ? value : JSON.stringify(value)}`;
}

/**
 * Adds the given information to the Copilot context to make it readable by Copilot.
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const [employees, setEmployees] = useState([]);
 *
 *   useCopilotReadable({
 *     description: "The list of employees",
 *     value: employees,
 *   });
 * }
 * ```
 *
 * @example Nested context with parentId
 * ```tsx
 * function Employee({ name, workProfile }) {
 *   const employeeContextId = useCopilotReadable({
 *     description: "Employee name",
 *     value: name
 *   });
 *
 *   useCopilotReadable({
 *     description: "Work profile",
 *     value: workProfile,
 *     parentId: employeeContextId
 *   });
 * }
 * ```
 */
export function useCopilotReadable(
  {
    description,
    value,
    parentId,
    categories,
    convert,
    available = 'enabled',
  }: UseCopilotReadableOptions,
  dependencies?: unknown[],
): string | undefined {
  const { addContext, removeContext } = useCopilotContext();
  const idRef = useRef<string>();
  const convertFn = convert || convertToJSON;

  const information = convertFn(description, value);

  useEffect(() => {
    if (available === 'disabled') return;

    const id = addContext(information, parentId, categories);
    idRef.current = id;

    return () => {
      removeContext(id);
    };
  }, [available, information, parentId, addContext, removeContext, ...(dependencies || [])]);

  return idRef.current;
}
