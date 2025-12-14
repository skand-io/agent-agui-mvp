import { Message as MessageType, TodoItem } from '../types';
import { TodoList } from './TodoList';
import styles from './Message.module.css';

interface MessageProps {
  message: MessageType;
}

export function Message({ message }: MessageProps) {
  // Check for todo_write tool calls to render inline
  const todoToolCall = message.toolCalls?.find(tc => tc.name === 'todo_write');
  let todos: TodoItem[] | null = null;

  if (todoToolCall) {
    try {
      const args = JSON.parse(todoToolCall.arguments);
      todos = args.todos;
    } catch {
      // Ignore parse errors
    }
  }

  const getClassName = () => {
    const classes = [styles.message, styles[message.role]];
    if (message.isFrontend) classes.push(styles.frontend);
    if (message.isBackend) classes.push(styles.backend);
    return classes.join(' ');
  };

  const getTestId = () => {
    const parts = ['message', message.role];
    if (message.isFrontend) parts.push('frontend');
    if (message.isBackend) parts.push('backend');
    return parts.join('-');
  };

  return (
    <div className={getClassName()} data-testid={getTestId()}>
      {/* Render todo list from tool calls (e.g., todo_write) */}
      {todos && <TodoList todos={todos} />}
      {/* Render message content */}
      {message.content}
      {/* Render current todo list after tool results for visual progress tracking */}
      {message.currentTodos && <TodoList todos={message.currentTodos} />}
    </div>
  );
}
