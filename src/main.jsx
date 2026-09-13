import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(_error, _errorInfo) {
    // Handled in state
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#09090b] text-zinc-100 p-6 flex items-center justify-center font-sans">
          <div className="max-w-lg w-full bg-zinc-900 border border-white/10 rounded-xl p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-2 text-rose-400 font-semibold text-base">
              <span>⚠️</span>
              <span>Something went wrong loading the recap</span>
            </div>
            <p className="text-xs text-zinc-400">
              An unexpected error occurred. You can reset saved state or reload to restore.
            </p>
            <pre className="text-[11px] bg-black/60 p-3 rounded text-rose-300 font-mono overflow-x-auto whitespace-pre-wrap">
              {this.state.error?.toString()}
            </pre>
            <button
              onClick={() => {
                try {
                  localStorage.removeItem('np5_active_pov');
                } catch {}
                window.location.reload();
              }}
              className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-black font-semibold text-xs rounded-lg transition-colors cursor-pointer"
            >
              Reset & Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootElement = document.querySelector('#root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  );
}
