import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import App from './App';
import Admin from './Admin';
import './App.css';
import './Admin.css';

class ErrorBoundary extends React.Component {
  constructor(props){
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error){
    return { hasError: true, error };
  }
  componentDidCatch(error, info){
    console.error('UI ErrorBoundary caught:', error, info);
  }
  render(){
    if(this.state.hasError){
      return (
        <div style={{ padding: 16, color: '#ff6677', fontFamily: 'monospace' }}>
          <div>Dashboard failed to render.</div>
          <div style={{ marginTop: 8, fontSize: 12 }}>{String(this.state.error)}</div>
          <div style={{ marginTop: 8, fontSize: 12 }}>Try hard refresh. If persists, I will patch immediately.</div>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<App />} />
          <Route path="/admin" element={<Admin />} />
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>
);
