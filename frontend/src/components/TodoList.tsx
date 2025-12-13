import { TodoItem } from '../types';
import styles from './TodoList.module.css';

interface TodoListProps {
  todos: TodoItem[];
}

export function TodoList({ todos }: TodoListProps) {
  const completed = todos.filter(t => t.status === 'completed').length;

  return (
    <div className={styles.todoList} data-testid="todo-list">
      <div className={styles.header} data-testid="todo-header">
        <span className={styles.title}>Planning</span>
        <span className={styles.progress}>
          {completed}/{todos.length} completed
        </span>
      </div>
      <div className={styles.items} data-testid="todo-items">
        {todos.map((todo) => (
          <div
            key={todo.id}
            className={`${styles.item} ${styles[todo.status]}`}
            data-testid={`todo-item-${todo.status}`}
          >
            <span className={styles.checkbox} data-testid="todo-checkbox">
              {todo.status === 'completed' ? '✓' :
               todo.status === 'in_progress' ? '◐' : '○'}
            </span>
            <span className={styles.content}>{todo.content}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
