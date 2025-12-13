import { Message as MessageType } from '../types';
import styles from './Message.module.css';

interface MessageProps {
  message: MessageType;
}

export function Message({ message }: MessageProps) {
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
      {message.content}
    </div>
  );
}
