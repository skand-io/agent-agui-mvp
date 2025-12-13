import { ChatContainer, DefaultActions } from './components';
import { CopilotProvider } from './context/CopilotContext';
import './App.css';

function App() {
  return (
    <CopilotProvider>
      <DefaultActions />
      <ChatContainer />
    </CopilotProvider>
  );
}

export default App;
