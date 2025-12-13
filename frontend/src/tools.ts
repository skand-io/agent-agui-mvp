import { ToolDefinition } from './types';

// Frontend tools - these execute in the browser
export const FRONTEND_TOOLS: Record<string, ToolDefinition> = {
  greet: {
    name: 'greet',
    description: 'Greet a person by name with a friendly message',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the person to greet' },
      },
      required: ['name'],
    },
    handler: ({ name }) => {
      console.log(`[FRONTEND TOOL] Hello, ${name}!`);
      alert(`Hello, ${name}! (This alert is from the frontend tool)`);
      return `Successfully greeted ${name}`;
    },
  },
  setTheme: {
    name: 'setTheme',
    description: 'Change the page theme/background color',
    parameters: {
      type: 'object',
      properties: {
        color: {
          type: 'string',
          description: "The background color (e.g., 'lightblue', '#ffcccc')",
        },
      },
      required: ['color'],
    },
    handler: ({ color }) => {
      console.log(`[FRONTEND TOOL] Setting theme to ${color}`);
      document.body.style.background = color;
      return `Theme changed to ${color}`;
    },
  },
};

// Convert tools to format expected by backend
export function getToolsForBackend() {
  return Object.values(FRONTEND_TOOLS).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}
