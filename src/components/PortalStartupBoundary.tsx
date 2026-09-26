import { Component, type ReactNode } from "react";

declare global {
  interface Window {
    __MBPortalBoot?: { ready: () => void; fail: (reason: string) => void };
  }
}

export class PortalStartupBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidMount() {
    if (!this.state.failed) window.__MBPortalBoot?.ready();
  }

  componentDidCatch() {
    window.__MBPortalBoot?.fail("render");
  }

  render() {
    if (this.state.failed) {
      return <p role="alert">Não foi possível abrir esta página. Tente carregá-la novamente.</p>;
    }
    return this.props.children;
  }
}
