import type { ToolDefinition } from './types';

/** Frontend tool definition for backend API */
export interface BackendToolFormat {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/**
 * Frontend tools that execute in the browser.
 * Note: greet and setTheme are now registered via DefaultActions.tsx using useCopilotAction.
 * This object is kept for backward compatibility but should be empty to avoid duplicates.
 */
export const FRONTEND_TOOLS: Record<string, ToolDefinition> = {};

/**
 * Convert frontend tools to format expected by backend API.
 * Returns tool definitions without handlers for LLM consumption.
 */
export function getToolsForBackend(): BackendToolFormat[] {
  return Object.values(FRONTEND_TOOLS).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: {
      type: tool.parameters.type,
      properties: Object.fromEntries(
        Object.entries(tool.parameters.properties).map(([key, value]) => [
          key,
          { type: value.type, description: value.description },
        ])
      ),
      required: [...tool.parameters.required],
    },
  }));
}
