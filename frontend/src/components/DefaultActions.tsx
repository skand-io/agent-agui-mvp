import { useCopilotAction } from '../hooks/useCopilotAction';

export function DefaultActions() {
  useCopilotAction({
    name: 'greet',
    description: 'Greet a person by name with an alert dialog',
    parameters: [
      {
        name: 'name',
        type: 'string',
        description: 'The name of the person to greet',
        required: true,
      },
    ],
    handler: ({ name }) => {
      alert(`Hello, ${name}!`);
      return `Greeted ${name} successfully`;
    },
  });

  useCopilotAction({
    name: 'setTheme',
    description: 'Change the background color of the page',
    parameters: [
      {
        name: 'color',
        type: 'string',
        description: 'The CSS color value (e.g., "red", "#ff0000", "rgb(255,0,0)")',
        required: true,
      },
    ],
    handler: ({ color }) => {
      document.body.style.backgroundColor = String(color);
      return `Theme changed to ${color}`;
    },
  });

  return null;
}
