import { Component } from "react";

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error("ErrorBoundary caught:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          minHeight: "100vh", background: "#0a0a0f", color: "#e0e0e0",
          fontFamily: "'Inter', system-ui, sans-serif", padding: "2rem",
        }}>
          <div style={{ textAlign: "center", maxWidth: 420 }}>
            <div style={{ fontSize: "2.5rem", marginBottom: "1rem" }}>Something went wrong</div>
            <div style={{ fontSize: ".85rem", color: "#888", marginBottom: "1.5rem", lineHeight: 1.6 }}>
              {this.state.error?.message || "An unexpected error occurred."}
            </div>
            <button
              onClick={() => { this.setState({ hasError: false, error: null }); }}
              style={{
                background: "#6c5ce7", color: "#fff", border: "none", borderRadius: 8,
                padding: ".7rem 1.5rem", fontSize: ".85rem", cursor: "pointer", marginRight: ".5rem",
              }}>
              Try Again
            </button>
            <button
              onClick={() => location.reload()}
              style={{
                background: "transparent", color: "#888", border: "1px solid #333", borderRadius: 8,
                padding: ".7rem 1.5rem", fontSize: ".85rem", cursor: "pointer",
              }}>
              Reload Page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
