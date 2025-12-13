import { ToolDefinition } from './types';

// Frontend tools - these execute in the browser
// Note: greet and setTheme are now registered via DefaultActions.tsx using useCopilotAction
// This object is kept for backward compatibility but should be empty to avoid duplicates
export const FRONTEND_TOOLS: Record<string, ToolDefinition> = {};

// Convert tools to format expected by backend
export function getToolsForBackend() {
  return Object.values(FRONTEND_TOOLS).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}
