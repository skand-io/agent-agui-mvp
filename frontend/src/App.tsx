import { ChatContainer, DefaultActions, ColorPicker, ContextDebugger, LLMPayloadDebugger } from './components';
import { CopilotProvider } from './context/CopilotContext';
import { PayloadProvider } from './context/PayloadContext';
import './App.css';

function App() {
  return (
    <CopilotProvider>
      <PayloadProvider>
        <DefaultActions />
        <div className="app-layout">
          <div className="sidebar">
            <ColorPicker />
            <ContextDebugger />
            <LLMPayloadDebugger />
          </div>
          <ChatContainer />
        </div>
      </PayloadProvider>
    </CopilotProvider>
  );
}

export default App;
