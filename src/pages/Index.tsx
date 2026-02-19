import { Navigate } from "react-router-dom";

// "/" is now the CaptivePortal — this page is no longer needed.
// Any legacy import will redirect to root.
const Index = () => <Navigate to="/" replace />;

export default Index;
